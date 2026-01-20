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

      // 1. Simpan ke tinv_hdr_tmp (Sesuai Logika Klerek)
      // inv_id biasanya otomatis atau UUID, inv_nomor diisi No. Struk Bazar
      const [resHdr] = await connection.query(
        `INSERT INTO tinv_hdr_tmp (
          inv_nomor, inv_tanggal, inv_cus_kode, 
          inv_rptunai, inv_rpcard, inv_nocard, inv_rpvoucher,
          user_create, date_create, inv_cab, inv_klerek
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 0)`,
        [
          header.so_nomor, // No Struk Bazar (B01-RIZAL-...)
          header.so_tanggal, // Tanggal Transaksi
          header.so_customer, // Kode Customer
          header.so_cash, // Pembayaran Tunai
          header.so_card, // Pembayaran Kartu
          header.so_bank_card, // Nama Bank/EDC (Akan di-join ke finance.trekening di Klerek)
          header.so_voucher, // Pembayaran Voucher
          header.so_user_kasir,
          targetCabang, // Kode Cabang
        ],
      );

      // 2. Simpan ke tinv_dtl_tmp
      for (const d of details) {
        await connection.query(
          `INSERT INTO tinv_dtl_tmp (
            invd_inv_nomor, invd_kode, invd_ukuran, 
            invd_jumlah, invd_harga, invd_diskon, invd_nourut
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            header.so_nomor,
            d.barcode || d.sod_brg_kode,
            d.ukuran || "",
            d.qty || d.sod_qty,
            d.harga || d.sod_harga,
            0, // Diskon item (jika ada)
            d.sod_nourut || 0,
          ],
        );

        // POTONG STOK (Real-time di Gudang Pameran)
        // Biasanya meskipun staging, stok pameran harus langsung berkurang
        await connection.query(
          `UPDATE tmasterstok SET mst_stok_out = mst_stok_out + ? 
           WHERE mst_brg_kode = ? AND mst_gdg_kode = ?`,
          [d.qty || d.sod_qty, d.barcode || d.sod_brg_kode, targetCabang],
        );
      }
    }

    await connection.commit();
    res
      .status(200)
      .json({ success: true, message: "Upload Staging Bazar Berhasil" });
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
