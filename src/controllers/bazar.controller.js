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

      // 1. Simpan Header (tso_hdr)
      await connection.query(
        `INSERT INTO tso_hdr (so_nomor, so_tanggal, so_customer, so_total, so_bayar, so_cash, so_card, so_voucher, so_kembali, so_bank_card, so_user_kasir, date_create) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          header.so_nomor,
          header.so_tanggal,
          header.so_customer,
          header.so_total,
          header.so_bayar,
          header.so_cash,
          header.so_card,
          header.so_voucher,
          header.so_kembali,
          header.so_bank_card,
          header.so_user_kasir,
        ],
      );

      // 2. Simpan Detail (tso_dtl) & Potong Stok
      for (const d of details) {
        await connection.query(
          // sod_satuan_kasir sekarang dinamis sesuai kiriman HP (PCS/LSN/CRT)
          `INSERT INTO tso_dtl (sod_so_nomor, sod_brg_kode, sod_qty, sod_harga, sod_satuan_kasir) VALUES (?, ?, ?, ?, ?)`,
          [
            header.so_nomor,
            d.sod_brg_kode,
            d.sod_qty,
            d.sod_harga,
            d.sod_satuan_kasir || "PCS",
          ],
        );

        // Potong stok master
        await connection.query(
          `UPDATE tmasterstok SET mst_stok_out = mst_stok_out + ? WHERE mst_brg_kode = ? AND mst_gdg_kode = ?`,
          [d.sod_qty, d.sod_brg_kode, targetCabang],
        );
      }
    }
    await connection.commit();
    res.status(200).json({ success: true });
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
