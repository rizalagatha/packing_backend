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
    if (kategori && kategori !== "ALL") {
      categoryFilter = "AND a.brg_ktgp = ?";
    }

    const query = `
      SELECT
        a.brg_kode AS kode,
        d.brgd_barcode AS barcode,
        TRIM(CONCAT_WS(' ', a.brg_jeniskaos, a.brg_tipe, a.brg_lengan, a.brg_jeniskain, a.brg_warna)) AS nama,
        d.brgd_ukuran AS ukuran,
        
        -- 1. Stok Real di Toko (Cabang Tujuan)
        IFNULL(s.stok, 0) AS stok_real,

        -- 2. Stok Real di DC (KDC) -> TAMBAHAN BARU
        IFNULL((
            SELECT SUM(m.mst_stok_in - m.mst_stok_out)
            FROM tmasterstok m
            WHERE m.mst_aktif = 'Y' 
              AND m.mst_brg_kode = a.brg_kode 
              AND m.mst_ukuran = d.brgd_ukuran
              AND m.mst_cab = 'KDC' -- Hardcode KDC sebagai Gudang Pusat
        ), 0) AS stok_dc,
        
        -- 3. Buffer stok
        IFNULL(d.brgd_min, 0) AS buffer_stok,
        
        -- 4. Average Sales (Qty)
        IFNULL((
            SELECT SUM(invd.invd_jumlah) / 3
            FROM tinv_dtl invd
            JOIN tinv_hdr invh ON invd.invd_inv_nomor = invh.inv_nomor
            WHERE invd.invd_kode = a.brg_kode 
              AND invd.invd_ukuran = d.brgd_ukuran
              AND LEFT(invh.inv_nomor, 3) = ? 
              AND invh.inv_tanggal >= DATE_SUB(NOW(), INTERVAL 3 MONTH)
        ), 0) AS avg_sales

      FROM tbarangdc a
      JOIN tbarangdc_dtl d ON a.brg_kode = d.brgd_kode

      -- Join Stok Real Toko
      LEFT JOIN (
        SELECT 
            m.mst_brg_kode, 
            m.mst_ukuran,
            SUM(m.mst_stok_in - m.mst_stok_out) as stok
        FROM tmasterstok m
        WHERE m.mst_aktif = 'Y' AND m.mst_tanggal <= ? AND m.mst_cab = ?
        GROUP BY m.mst_brg_kode, m.mst_ukuran
      ) s ON a.brg_kode = s.mst_brg_kode AND d.brgd_ukuran = s.mst_ukuran

      WHERE a.brg_aktif = 0 AND a.brg_logstok = 'Y' ${categoryFilter}
      
      HAVING stok_real < buffer_stok AND buffer_stok > 0
      
      ORDER BY stok_real ASC, avg_sales DESC
      LIMIT ?;
    `;

    const queryParams = [
      req.query.cabang, // avg_sales
      new Date(), // stok toko (date)
      req.query.cabang, // stok toko (cabang)
    ];

    if (kategori && kategori !== "ALL") {
      queryParams.push(kategori);
    }

    queryParams.push(parseInt(limit));

    const [rows] = await pool.query(query, queryParams);

    const formattedRows = rows.map((item) => ({
      ...item,
      avg_sales: parseFloat(item.avg_sales).toFixed(1), // Qty dengan 1 desimal
      stok_real: parseFloat(item.stok_real),
      stok_dc: parseFloat(item.stok_dc), // Tambahkan ini
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
