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

      // 1. Perbaikan Format Tanggal (Ambil 10 karakter pertama: YYYY-MM-DD)
      const formattedDate = header.so_tanggal.substring(0, 10);

      // 2. Sesuaikan Panjang Nomor (Max 20 Karakter)
      const cleanNomor = header.so_nomor.substring(0, 20);

      // 3. Simpan ke tinv_hdr_tmp
      await connection.query(
        `INSERT INTO tinv_hdr_tmp (
          inv_id, inv_nomor, inv_tanggal, inv_cus_kode, 
          inv_rptunai, inv_rpcard, inv_nocard, inv_rpvoucher,
          user_create, date_create, inv_klerek, inv_ket
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '0', ?)`,
        [
          cleanNomor,
          cleanNomor,
          formattedDate, // Pakai yang sudah di-format YYYY-MM-DD
          header.so_customer,
          header.so_cash,
          header.so_card,
          header.so_bank_card,
          header.so_voucher,
          header.so_user_kasir,
          "BAZAR ANDROID",
        ],
      );

      // 4. Simpan ke tinv_dtl_tmp
      for (const d of details) {
        await connection.query(
          `INSERT INTO tinv_dtl_tmp (
            invd_inv_nomor, invd_kode, invd_ukuran, 
            invd_jumlah, invd_harga, invd_diskon, invd_nourut
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            cleanNomor,
            d.barcode || d.sod_brg_kode,
            d.ukuran || "",
            d.qty || d.sod_qty,
            d.harga || d.sod_harga,
            0,
            0,
          ],
        );

        // Update stok gudang pameran
        await connection.query(
          `UPDATE tmasterstok SET mst_stok_out = mst_stok_out + ? 
           WHERE mst_brg_kode = ? AND mst_gdg_kode = ?`,
          [d.qty || d.sod_qty, d.barcode || d.sod_brg_kode, targetCabang],
        );
      }
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Upload Berhasil" });
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
