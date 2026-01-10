const pool = require("../config/database");
const { format } = require("date-fns");

/**
 * Mendapatkan Stok Real Time (Semua barang)
 * Dioptimalkan untuk Mobile dengan filter pencarian
 */
const getRealTimeStock = async (req, res) => {
  const { gudang, search, jenisStok, tampilkanKosong, tanggal } = req.query;
  const connection = await pool.getConnection();

  try {
    // Konversi string ke boolean dari query params
    const isShowZero = String(tampilkanKosong) === "true";

    // 1. Tentukan Sumber Tabel
    let stockSourceTable = "";
    if (jenisStok === "showroom") {
      stockSourceTable = "tmasterstok";
    } else if (jenisStok === "pesanan") {
      stockSourceTable = "tmasterstokso";
    } else {
      stockSourceTable = `(
        SELECT mst_brg_kode, mst_ukuran, mst_stok_in, mst_stok_out, mst_cab, mst_tanggal, mst_aktif FROM tmasterstok
        UNION ALL
        SELECT mst_brg_kode, mst_ukuran, mst_stok_in, mst_stok_out, mst_cab, mst_tanggal, mst_aktif FROM tmasterstokso
      )`;
    }

    // 2. Query Ukuran secara Dinamis (Master ukuran agar kolom lengkap seperti di web)
    const [sizes] = await connection.query(
      `SELECT DISTINCT brgd_ukuran AS mst_ukuran FROM tbarangdc_dtl ORDER BY brgd_ukuran`
    );

    let dynamicColumns = "";
    if (sizes.length > 0) {
      dynamicColumns = sizes
        .map(
          (s) =>
            `SUM(CASE WHEN s.mst_ukuran = '${s.mst_ukuran}' THEN s.stok ELSE 0 END) AS '${s.mst_ukuran}'`
        )
        .join(", ");
      dynamicColumns = ", " + dynamicColumns;
    }

    // 3. Siapkan Parameter Dasar
    let params = [tanggal];
    let gudangFilter = "1 = 1";
    if (gudang && gudang !== "ALL") {
      gudangFilter = `m.mst_cab = ?`;
      params.push(gudang);
    }

    // 4. LOGIKA PENCARIAN PINTAR (Multi-Word Search)
    let searchFilter = "";
    if (search) {
      // Pecah string pencarian berdasarkan spasi (misal: "ko polos pendek" -> ["ko", "polos", "pendek"])
      const words = search.trim().split(/\s+/);

      // Buat blok AND untuk setiap kata
      searchFilter = words
        .map(() => {
          return `AND (
          a.brg_kode LIKE ? 
          OR a.brg_jeniskaos LIKE ? 
          OR a.brg_tipe LIKE ? 
          OR a.brg_lengan LIKE ? 
          OR a.brg_jeniskain LIKE ? 
          OR a.brg_warna LIKE ?
        )`;
        })
        .join(" ");

      // Masukkan setiap kata ke dalam array parameter (sesuai jumlah placeholder ?)
      words.forEach((word) => {
        const p = `%${word}%`;
        params.push(p, p, p, p, p, p); // 6 kolom per kata
      });
    }

    // 5. Query Utama
    const query = `
        SELECT
            a.brg_kode AS kode,
            TRIM(CONCAT_WS(' ', a.brg_jeniskaos, a.brg_tipe, a.brg_lengan, a.brg_jeniskain, a.brg_warna)) AS nama
            ${dynamicColumns}
            , SUM(IFNULL(s.stok, 0)) AS total_stok
            , IFNULL((SELECT SUM(brgd_min) FROM tbarangdc_dtl b WHERE b.brgd_kode = a.brg_kode), 0) AS Buffer
        FROM tbarangdc a
        LEFT JOIN (
            SELECT 
                m.mst_brg_kode, 
                m.mst_ukuran, 
                SUM(m.mst_stok_in - m.mst_stok_out) as stok
            FROM ${stockSourceTable} m
            WHERE m.mst_aktif = 'Y' AND m.mst_tanggal <= ? AND ${gudangFilter}
            GROUP BY m.mst_brg_kode, m.mst_ukuran
        ) s ON a.brg_kode = s.mst_brg_kode
        WHERE a.brg_aktif = 0 AND a.brg_logstok = 'Y' ${searchFilter}
        GROUP BY a.brg_kode, nama
        ${!isShowZero ? "HAVING total_stok > 0" : ""}
        ORDER BY nama ASC
        LIMIT 500;
    `;

    const [rows] = await connection.query(query, params);
    res.json({
      success: true,
      data: rows,
      sizes: sizes.map((s) => s.mst_ukuran),
    });
  } catch (error) {
    console.error("Error RealTimeStock:", error);
    res.status(500).json({ success: false, message: "Gagal memuat stok." });
  } finally {
    connection.release();
  }
};

/**
 * Analisis Stok Menipis (Sesuai format yang Abang minta)
 */
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

    let categoryFilter =
      kategori && kategori !== "ALL" ? "AND a.brg_ktgp = ?" : "";

    const query = `
            SELECT
                a.brg_kode AS kode,
                d.brgd_barcode AS barcode,
                TRIM(CONCAT_WS(' ', a.brg_jeniskaos, a.brg_tipe, a.brg_lengan, a.brg_jeniskain, a.brg_warna)) AS nama,
                d.brgd_ukuran AS ukuran,
                IFNULL(s.stok, 0) AS stok_real,
                IFNULL((
                    SELECT SUM(m.mst_stok_in - m.mst_stok_out)
                    FROM tmasterstok m
                    WHERE m.mst_aktif = 'Y' AND m.mst_brg_kode = a.brg_kode AND m.mst_ukuran = d.brgd_ukuran AND m.mst_cab = 'KDC'
                ), 0) AS stok_dc,
                IFNULL(d.brgd_min, 0) AS buffer_stok,
                IFNULL((
                    SELECT SUM(invd.invd_jumlah) / 3
                    FROM tinv_dtl invd
                    JOIN tinv_hdr invh ON invd.invd_inv_nomor = invh.inv_nomor
                    WHERE invd.invd_kode = a.brg_kode AND invd.invd_ukuran = d.brgd_ukuran AND invh.inv_cab = ? 
                      AND invh.inv_tanggal >= DATE_SUB(NOW(), INTERVAL 3 MONTH)
                ), 0) AS avg_sales
            FROM tbarangdc a
            JOIN tbarangdc_dtl d ON a.brg_kode = d.brgd_kode
            LEFT JOIN (
                SELECT m.mst_brg_kode, m.mst_ukuran, SUM(m.mst_stok_in - m.mst_stok_out) as stok
                FROM tmasterstok m
                WHERE m.mst_aktif = 'Y' AND m.mst_cab = ?
                GROUP BY m.mst_brg_kode, m.mst_ukuran
            ) s ON a.brg_kode = s.mst_brg_kode AND d.brgd_ukuran = s.mst_ukuran
            WHERE a.brg_aktif = 0 AND a.brg_logstok = 'Y' ${categoryFilter}
            HAVING stok_real < buffer_stok AND buffer_stok > 0
            ORDER BY stok_real ASC, avg_sales DESC
            LIMIT ?;
        `;

    const queryParams = [cabang, cabang, parseInt(limit)];
    if (categoryFilter) queryParams.splice(2, 0, kategori);

    const [rows] = await pool.query(query, queryParams);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Gagal menganalisis stok." });
  }
};

/**
 * Mengambil daftar gudang untuk pilihan filter
 */
const getGudangOptions = async (req, res) => {
  try {
    const user = req.user;
    let query = "";
    let params = [];

    if (user.cabang === "KDC") {
      // User KDC tetap bisa lihat semua
      query = `
        SELECT 'ALL' AS kode, 'SEMUA GUDANG' AS nama
        UNION ALL
        SELECT gdg_kode AS kode, gdg_nama AS nama FROM tgudang ORDER BY kode;
      `;
    } else {
      // User Store hanya bisa melihat cabangnya sendiri DAN KDC Pusat
      query = `
        SELECT gdg_kode AS kode, gdg_nama AS nama 
        FROM tgudang 
        WHERE gdg_kode = 'KDC' OR gdg_kode = ?
        ORDER BY (gdg_kode = 'KDC') DESC; -- KDC muncul di paling atas
      `;
      params.push(user.cabang);
    }

    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat daftar gudang." });
  }
};

module.exports = {
  getRealTimeStock,
  getLowStock,
  getGudangOptions,
};
