const pool = require("../config/database");

const getLowStock = async (req, res) => {
  try {
    const { cabang, kategori, limit = 20 } = req.query;

    // Validasi: Cabang (Gudang Tujuan) wajib dipilih
    if (!cabang || cabang === "ALL") {
      return res
        .status(400)
        .json({
          success: false,
          message: "Silakan pilih cabang/toko terlebih dahulu.",
        });
    }

    // Parameter dasar
    let params = [new Date(), cabang];
    let categoryFilter = "";

    // Filter Kategori Opsional
    if (kategori && kategori !== "ALL") {
      categoryFilter = "AND a.brg_ktgp = ?";
      params.push(kategori);
    }

    // Query Utama (Adaptasi dari referensi Anda)
    const query = `
      SELECT
        a.brg_kode AS kode,
        a.brg_barcode AS barcode,
        TRIM(CONCAT_WS(' ', a.brg_jeniskaos, a.brg_tipe, a.brg_lengan, a.brg_jeniskain, a.brg_warna)) AS nama,
        a.brg_ukuran AS ukuran,
        IFNULL(SUM(s.stok), 0) AS stok_real,
        IFNULL((SELECT SUM(brgd_min) FROM tbarangdc_dtl b WHERE b.brgd_kode = a.brg_kode AND b.brgd_ukuran = a.brg_ukuran), 0) AS buffer_stok,
        
        -- Hitung Average Sales (3 bulan terakhir / 3)
        -- (Ini adalah estimasi sederhana berdasarkan referensi Anda)
        IFNULL((
            SELECT SUM(d.invd_jumlah) / 3
            FROM tinv_dtl d
            JOIN tinv_hdr h ON d.invd_inv_nomor = h.inv_nomor
            WHERE d.invd_kode = a.brg_kode 
              AND d.invd_ukuran = a.brg_ukuran
              AND LEFT(h.inv_nomor, 3) = ? -- Filter penjualan di cabang tersebut
              AND h.inv_tanggal >= DATE_SUB(NOW(), INTERVAL 3 MONTH)
        ), 0) AS avg_sales

      FROM tbarangdc a
      -- Join untuk mendapatkan stok real saat ini di cabang tersebut
      LEFT JOIN (
        SELECT 
            m.mst_brg_kode, 
            m.mst_ukuran,
            SUM(m.mst_stok_in - m.mst_stok_out) as stok
        FROM tmasterstok m
        WHERE m.mst_aktif = 'Y' AND m.mst_tanggal <= ? AND m.mst_cab = ?
        GROUP BY m.mst_brg_kode, m.mst_ukuran
      ) s ON a.brg_kode = s.mst_brg_kode AND a.brg_ukuran = s.mst_ukuran

      WHERE a.brg_aktif = 0 AND a.brg_logstok = 'Y' ${categoryFilter}
      
      GROUP BY a.brg_kode, a.brg_ukuran, nama
      
      -- Filter Inti: Hanya tampilkan yang stoknya di bawah buffer
      HAVING stok_real < buffer_stok AND buffer_stok > 0
      
      -- Sorting: Stok paling kritis dulu, lalu yang penjualannya tinggi
      ORDER BY stok_real ASC, avg_sales DESC
      LIMIT ?;
    `;

    // Tambahkan parameter limit dan cabang (untuk subquery avg sales)
    // Urutan params harus sesuai dengan tanda tanya (?) di query
    // 1. NOW() -> sudah di params[0]
    // 2. cabang (untuk subquery stok) -> sudah di params[1]
    // 3. kategori (opsional) -> sudah di params[2] jika ada
    // 4. cabang (untuk subquery avg sales) -> perlu ditambahkan
    // 5. limit -> perlu ditambahkan

    // Koreksi urutan parameter agar sesuai query
    const queryParams = [
      req.query.cabang, // Untuk subquery Avg Sales
      new Date(), // Untuk subquery Stok (tanggal)
      req.query.cabang, // Untuk subquery Stok (cabang)
    ];

    if (kategori && kategori !== "ALL") {
      queryParams.push(kategori);
    }

    queryParams.push(parseInt(limit));

    const [rows] = await pool.query(query, queryParams);

    // Format angka desimal agar rapi
    const formattedRows = rows.map((item) => ({
      ...item,
      avg_sales: parseFloat(item.avg_sales).toFixed(1),
      stok_real: parseFloat(item.stok_real),
      buffer_stok: parseFloat(item.buffer_stok),
    }));

    res.status(200).json({ success: true, data: formattedRows });
  } catch (error) {
    console.error("Error in getLowStock:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal menganalisis stok." });
  }
};

module.exports = {
  getLowStock,
};
