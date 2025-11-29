const pool = require("../config/database");

const getLowStock = async (req, res) => {
  try {
    const { cabang, kategori, limit = 20 } = req.query;

    if (!cabang || cabang === "ALL") {
      return res
        .status(400)
        .json({
          success: false,
          message: "Silakan pilih cabang/toko terlebih dahulu.",
        });
    }

    let categoryFilter = "";
    // Filter Kategori Opsional
    if (kategori && kategori !== "ALL") {
      categoryFilter = "AND a.brg_ktgp = ?";
    }

    const query = `
      SELECT
        a.brg_kode AS kode,
        d.brgd_barcode AS barcode,
        TRIM(CONCAT_WS(' ', a.brg_jeniskaos, a.brg_tipe, a.brg_lengan, a.brg_jeniskain, a.brg_warna)) AS nama,
        d.brgd_ukuran AS ukuran,
        
        -- Stok Real
        IFNULL(s.stok, 0) AS stok_real,
        
        -- Buffer stok
        IFNULL(d.brgd_min, 0) AS buffer_stok,
        
        -- Hitung Average Sales (Nominal Rupiah)
        IFNULL((
            SELECT SUM((invd.invd_harga - invd.invd_diskon) * invd.invd_jumlah) / 3
            FROM tinv_dtl invd
            JOIN tinv_hdr invh ON invd.invd_inv_nomor = invh.inv_nomor
            WHERE invd.invd_kode = a.brg_kode 
              AND invd.invd_ukuran = d.brgd_ukuran
              AND LEFT(invh.inv_nomor, 3) = ? -- Param 1: Cabang
              AND invh.inv_tanggal >= DATE_SUB(NOW(), INTERVAL 3 MONTH)
        ), 0) AS avg_sales

      FROM tbarangdc a
      JOIN tbarangdc_dtl d ON a.brg_kode = d.brgd_kode

      -- Join Stok Real
      LEFT JOIN (
        SELECT 
            m.mst_brg_kode, 
            m.mst_ukuran,
            SUM(m.mst_stok_in - m.mst_stok_out) as stok
        FROM tmasterstok m
        WHERE m.mst_aktif = 'Y' AND m.mst_tanggal <= ? AND m.mst_cab = ? -- Param 2 & 3
        GROUP BY m.mst_brg_kode, m.mst_ukuran
      ) s ON a.brg_kode = s.mst_brg_kode AND d.brgd_ukuran = s.mst_ukuran

      WHERE a.brg_aktif = 0 AND a.brg_logstok = 'Y' ${categoryFilter}
      
      HAVING stok_real < buffer_stok AND buffer_stok > 0
      
      ORDER BY stok_real ASC, avg_sales DESC
      LIMIT ?; -- Param Terakhir
    `;

    const queryParams = [
      req.query.cabang, // 1. Cabang (untuk avg sales)
      new Date(), // 2. Tanggal (untuk stok)
      req.query.cabang, // 3. Cabang (untuk stok)
    ];

    if (kategori && kategori !== "ALL") {
      queryParams.push(kategori); // 4. Kategori (jika ada)
    }

    queryParams.push(parseInt(limit)); // 5. Limit

    const [rows] = await pool.query(query, queryParams);

    const formattedRows = rows.map((item) => ({
      ...item,
      // Format angka desimal
      avg_sales: parseFloat(item.avg_sales),
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
