const pool = require("../config/database");

const downloadMasterBazar = async (req, res) => {
  try {
    // 1. Query Barang
    const queryBarang = `
  SELECT 
    TRIM(d.brgd_barcode) AS barcode,
    d.brgd_kode AS kode,
    TRIM(CONCAT(
      IFNULL(h.brg_jeniskaos, ''), ' ', 
      IFNULL(h.brg_tipe, ''), ' ', 
      IFNULL(h.brg_lengan, ''), ' ', 
      IFNULL(h.brg_jeniskain, ''), ' ', 
      IFNULL(h.brg_warna, '')
    )) AS nama,
    IFNULL(d.brgd_ukuran, '') AS ukuran,
    IFNULL(d.brgd_harga, 0) AS harga_jual,
    h.brg_minqty AS promo_qty, 
    h.brg_ket AS keterangan,
    IFNULL(h.brg_ktg, '') AS kategori,
    IFNULL(h.brg_ktgp, '') AS tipe_produk
  FROM tbarangdc_dtl d
  LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
  ORDER BY d.brgd_barcode ASC;
`;

    // 2. Query Customer
    const queryCustomer = `
      SELECT cus_kode, cus_nama, IFNULL(cus_alamat, '') as cus_alamat 
      FROM tcustomer 
      ORDER BY cus_nama ASC;
    `;

    // 3. [TAMBAHAN] Query Rekening Bank / EDC
    const queryRekening = `
      SELECT DISTINCT
        rek_rekening AS nomor_rekening, 
        rek_nama AS nama_bank 
      FROM finance.trekening 
      WHERE rek_isaktif = 0
      ORDER BY rek_nama ASC;
    `;

    // Jalankan ketiga query secara paralel
    const [[products], [customers], [rekening]] = await Promise.all([
      pool.query(queryBarang),
      pool.query(queryCustomer),
      pool.query(queryRekening), // Tambahkan ini
    ]);

    res.status(200).json({
      success: true,
      message: "Data master bazar berhasil dimuat.",
      data: {
        products: products,
        customers: customers,
        rekening: rekening, // Kirim ke Android
      },
    });
  } catch (error) {
    console.error("Error downloadMasterBazar:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data master.",
    });
  }
};

const uploadKoreksiBazar = async (req, res) => {
  const { header, details, targetCabang } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Simpan Header (tkor_hdr)
    const qHdr = `
      INSERT INTO tkor_hdr 
      (korh_nomor, korh_tanggal, korh_notes, korh_gdg_kode, korh_total, date_create, user_create)
      VALUES (?, ?, ?, ?, ?, NOW(), ?)
    `;
    await connection.query(qHdr, [
      header.no_koreksi,
      header.tanggal,
      "KOREKSI ANDROID BAZAR",
      targetCabang,
      header.total_nilai || 0,
      header.operator || "ADMIN",
    ]);

    // 2. Simpan Detail (tkor_dtl)
    const qDtl = `
      INSERT INTO tkor_dtl 
      (kord_korh_nomor, kord_brg_kode, kord_qty, kord_stok)
      VALUES (?, ?, ?, ?)
    `;

    for (const item of details) {
      await connection.query(qDtl, [
        header.no_koreksi,
        item.barcode,
        item.selisih, // Nilai selisih (bisa plus atau minus)
        item.qty_sistem,
      ]);
    }

    await connection.commit();
    res
      .status(200)
      .json({ success: true, message: "Koreksi stok berhasil di-upload." });
  } catch (error) {
    await connection.rollback();
    console.error("Error uploadKoreksiBazar:", error);
    res.status(500).json({
      success: false,
      message: "Gagal menyimpan koreksi ke database pusat.",
    });
  } finally {
    connection.release();
  }
};

const generateNewSetorNomor = async (connection, tanggal, cabang) => {
  const date = new Date(tanggal);
  const ayymm =
    date.getFullYear().toString().slice(-2) +
    (date.getMonth() + 1).toString().padStart(2, "0");
  const prefix = `${cabang}.STR.${ayymm}.`;

  const [rows] = await connection.query(
    "SELECT IFNULL(MAX(RIGHT(sh_nomor, 4)), 0) as max_nomor FROM tsetor_hdr WHERE LEFT(sh_nomor, 12) = ?",
    [prefix],
  );

  const nextNum = parseInt(rows[0].max_nomor, 10) + 1;
  return `${prefix}${String(nextNum).padStart(4, "0")}`;
};

const uploadBazarSales = async (req, res) => {
  const { sales, targetCabang } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Ambil waktu sekarang untuk base ID (14 digit: YYYYMMDDHHMMSS)
    const now = new Date();
    const timePart =
      now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, "0") +
      now.getDate().toString().padStart(2, "0") +
      now.getHours().toString().padStart(2, "0") +
      now.getMinutes().toString().padStart(2, "0") +
      now.getSeconds().toString().padStart(2, "0");

    for (let notaIdx = 0; notaIdx < sales.length; notaIdx++) {
      const { header, details } = sales[notaIdx];
      const invIdHeader =
        `${timePart}.${(notaIdx + 1).toString().padStart(2, "0")}00`.substring(
          0,
          20,
        );
      const formattedDate = header.so_tanggal.substring(0, 10);
      let cleanNomor = header.so_nomor.substring(0, 20);

      // --- LOGIKA SETORAN (CARD/TRANSFER) ---
      let inv_nosetor = "";
      let inv_jeniscard = "";
      if (header.so_card > 0) {
        inv_nosetor = await generateNewSetorNomor(
          connection,
          formattedDate,
          targetCabang,
        );
        inv_jeniscard = "D"; // 'D' untuk Debit sesuai data lama
      }

      await connection.query(`DELETE FROM tinv_hdr_tmp WHERE inv_nomor = ?`, [
        cleanNomor,
      ]);
      await connection.query(
        `DELETE FROM tinv_dtl_tmp WHERE invd_inv_nomor = ?`,
        [cleanNomor],
      );

      // 5. INSERT HEADER
      await connection.query(
        `INSERT INTO tinv_hdr_tmp (
          inv_id, inv_nomor, inv_tanggal, inv_cus_kode, 
          inv_rptunai, inv_rpcard, inv_nocard, inv_namabank, inv_jeniscard, inv_nosetor,
          user_create, date_create, inv_klerek, inv_ket
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '0', ?)`,
        [
          invIdHeader,
          cleanNomor,
          formattedDate,
          header.so_customer,
          header.so_cash || 0,
          header.so_card || 0,
          header.so_bank_card || "", // Diisi Nomor Rekening dari HP
          header.so_bank_name || "", // Diisi Nama Bank dari HP
          inv_jeniscard,
          inv_nosetor,
          header.so_user_kasir,
          "BAZAR ANDROID",
        ],
      );

      // 6. INSERT DETAIL
      for (let i = 0; i < details.length; i++) {
        const d = details[i];
        const itemCode = d.barcode || d.sod_brg_kode;
        const itemQty = d.qty || d.sod_qty;
        const itemSize = d.ukuran || "";

        // 7. GENERATE invd_idd (PK Detail) - Total 20 Karakter
        // Format: YYYYMMDDHHMMSS + "." + NoUrutNota(2) + NoUrutItem(3)
        // Contoh: 20260120195506.01001 (Item 1), 20260120195506.01002 (Item 2)
        const invdIdd = `${timePart}.${(notaIdx + 1).toString().padStart(2, "0")}${(i + 1).toString().padStart(3, "0")}`;

        await connection.query(
          `INSERT INTO tinv_dtl_tmp (
            invd_id, 
            invd_idd, 
            invd_inv_nomor, 
            invd_kode, 
            invd_ukuran, 
            invd_jumlah, 
            invd_harga, 
            invd_diskon, 
            invd_nourut
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            invIdHeader, // invd_id merujuk ke ID di Header
            invdIdd, // invd_idd (PK UNIK)
            cleanNomor,
            itemCode,
            itemSize,
            itemQty,
            d.harga || d.sod_harga,
            0,
            i + 1,
          ],
        );

        // 8. UPDATE STOK
        await connection.query(
          `UPDATE tmasterstok 
           SET mst_stok_out = mst_stok_out + ? 
           WHERE mst_brg_kode = ? 
             AND mst_cab = ? 
             AND mst_ukuran = ?`,
          [itemQty, itemCode, targetCabang, itemSize],
        );
      }
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Upload Sukses!" });
  } catch (error) {
    await connection.rollback();
    console.error("Error uploadBazarSales:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

module.exports = {
  downloadMasterBazar,
  uploadKoreksiBazar,
  uploadBazarSales,
  // Fungsi uploadInvoice dan lainnya akan kita tambahkan di sini nanti
};
