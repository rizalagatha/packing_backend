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

    // Jalankan kedua query secara paralel agar cepat
    const [[products], [customers]] = await Promise.all([
      pool.query(queryBarang),
      pool.query(queryCustomer),
    ]);

    res.status(200).json({
      success: true,
      message: "Data master bazar berhasil dimuat.",
      data: {
        products: products,
        customers: customers,
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

const uploadBazarSales = async (req, res) => {
  const { sales, targetCabang } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const nota of sales) {
      const { header, details } = nota;

      // 1. GENERATE inv_id (Format: YYYYMMDDHHMMSS.sss)
      // Kita buat ID unik berdasarkan waktu saat ini agar tidak bentrok
      const now = new Date();
      const invId =
        now.getFullYear().toString() +
        (now.getMonth() + 1).toString().padStart(2, "0") +
        now.getDate().toString().padStart(2, "0") +
        now.getHours().toString().padStart(2, "0") +
        now.getMinutes().toString().padStart(2, "0") +
        now.getSeconds().toString().padStart(2, "0") +
        "." +
        now.getMilliseconds().toString().padStart(3, "0");

      // 2. FIX TANGGAL (YYYY-MM-DD)
      const formattedDate = header.so_tanggal.substring(0, 10);

      // 3. FIX NOMOR (Max 20 Karakter)
      // Jika nomor nota > 20, kita potong tengahnya agar counter belakang tidak hilang
      let cleanNomor = header.so_nomor;
      if (cleanNomor.length > 20) {
        cleanNomor = cleanNomor.substring(0, 17) + cleanNomor.slice(-3);
      }

      // 4. INSERT HEADER (tinv_hdr_tmp)
      // Gunakan REPLACE agar jika nomor nota sama, ID lama ditimpa (menghindari duplikat staging)
      // Catatan: Karena inv_id berbeda setiap detik, kita hapus dulu berdasarkan inv_nomor
      await connection.query(`DELETE FROM tinv_hdr_tmp WHERE inv_nomor = ?`, [
        cleanNomor,
      ]);

      await connection.query(
        `INSERT INTO tinv_hdr_tmp (
          inv_id, inv_nomor, inv_tanggal, inv_cus_kode, 
          inv_rptunai, inv_rpcard, inv_nocard, inv_rpvoucher,
          user_create, date_create, inv_klerek, inv_ket
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '0', ?)`,
        [
          invId.substring(0, 20), // inv_id (PK)
          cleanNomor, // inv_nomor
          formattedDate,
          header.so_customer,
          header.so_cash,
          header.so_card,
          header.so_bank_card,
          header.so_voucher,
          header.so_user_kasir,
          "BAZAR ANDROID",
        ],
      );

      // 5. INSERT DETAIL (tinv_dtl_tmp)
      // Bersihkan detail lama dengan nomor nota yang sama
      await connection.query(
        `DELETE FROM tinv_dtl_tmp WHERE invd_inv_nomor = ?`,
        [cleanNomor],
      );

      for (let i = 0; i < details.length; i++) {
        const d = details[i];
        const itemCode = d.barcode || d.sod_brg_kode;
        const itemQty = d.qty || d.sod_qty;
        const itemSize = d.ukuran || "";

        // Generate invd_id (PK Detail) unik
        const invdId = (invId + i).substring(0, 20);

        await connection.query(
          `INSERT INTO tinv_dtl_tmp (
            invd_id, invd_inv_nomor, invd_kode, invd_ukuran, 
            invd_jumlah, invd_harga, invd_diskon, invd_nourut
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            invdId,
            cleanNomor,
            itemCode,
            itemSize,
            itemQty,
            d.harga || d.sod_harga,
            0,
            i + 1,
          ],
        );

        // 6. UPDATE STOK (tmasterstok)
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
    res
      .status(200)
      .json({ success: true, message: "Upload Sukses Ke Staging!" });
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
