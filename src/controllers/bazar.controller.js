const pool = require("../config/database");

const downloadMasterBazar = async (req, res) => {
  try {
    // 1. Query Barang
    const queryBarang = `
      SELECT 
        TRIM(d.brgd_barcode) AS barcode,
        d.brgd_kode AS kode,
        TRIM(CONCAT(IFNULL(h.brg_jeniskaos, ''), ' ', IFNULL(h.brg_tipe, ''), ' ', IFNULL(h.brg_lengan, ''), ' ', IFNULL(h.brg_jeniskain, ''), ' ', IFNULL(h.brg_warna, ''))) AS nama,
        IFNULL(d.brgd_ukuran, '') AS ukuran,
        IFNULL(d.brgd_harga, 0) AS harga_jual,
        IFNULL(h.brg_hrgbeli, 0) AS harga_beli,
        IFNULL(h.brg_ktg, '') AS kategori
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

module.exports = {
  downloadMasterBazar,
  // Fungsi uploadInvoice dan lainnya akan kita tambahkan di sini nanti
};
