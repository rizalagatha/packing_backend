const pool = require("../config/database");
const { format } = require("date-fns");

/**
 * Melengkapi setiap row hasil getRealTimeStock dengan breakdown
 * Pesanan Booked (SO masih OPEN, belum ke-scan) dan Pesanan Ready
 * (stok toko yang sudah direservasi untuk SO), masing-masing per ukuran.
 * Mutasi langsung ke `rows` — dipanggil hanya saat mode toko spesifik.
 */
const attachPesananDetail = async (connection, rows, gudang) => {
  const bookedQuery = `
    WITH open_so AS (
      SELECT Nomor
      FROM (
        SELECT
          y.Nomor,
          CASE
            WHEN y.sts <> 0 THEN 'DICLOSE'
            WHEN y.StatusKirim = 'TERKIRIM' THEN 'CLOSE'
            WHEN y.StatusKirim = 'BELUM' AND y.keluar = 0 AND y.minta = '' AND y.pesan = 0 THEN 'OPEN'
            ELSE 'PROSES'
          END AS StatusFinal
        FROM (
          SELECT
            x.*,
            IF(x.QtyInv = 0, 'BELUM', IF(x.QtyInv >= x.QtySO, 'TERKIRIM', 'SEBAGIAN')) AS StatusKirim,
            IFNULL((
              SELECT SUM(m.mst_stok_out)
              FROM tmasterstok m
              WHERE m.mst_noreferensi IN (
                SELECT o.mo_nomor FROM tmutasiout_hdr o WHERE o.mo_so_nomor = x.Nomor
              )
            ), 0) AS keluar,
            IFNULL((
              SELECT mt_nomor FROM tmintabarang_hdr WHERE mt_so = x.Nomor LIMIT 1
            ), '') AS minta,
            IFNULL((
              SELECT SUM(mst_stok_in - mst_stok_out)
              FROM tmasterstokso
              WHERE mst_aktif = 'Y' AND mst_nomor_so = x.Nomor
            ), 0) AS pesan
          FROM (
            SELECT
              h.so_nomor AS Nomor,
              h.so_close AS sts,
              IFNULL((SELECT SUM(dd.sod_jumlah) FROM tso_dtl dd WHERE dd.sod_so_nomor = h.so_nomor), 0) AS QtySO,
              IFNULL((
                SELECT SUM(dd.invd_jumlah)
                FROM tinv_hdr hh
                JOIN tinv_dtl dd ON dd.invd_inv_nomor = hh.inv_nomor
                WHERE hh.inv_sts_pro = 0 AND hh.inv_nomor_so = h.so_nomor
              ), 0) AS QtyInv
            FROM tso_hdr h
            WHERE h.so_close = 0 AND h.so_aktif = 'Y' AND h.so_cab = ?
          ) x
        ) y
      ) z
      WHERE z.StatusFinal = 'OPEN'
    )
    SELECT d.sod_kode AS kode, d.sod_ukuran AS ukuran,
           SUM(d.sod_jumlah - IFNULL(d.sod_scanned, 0)) AS qty
    FROM open_so os
    JOIN tso_dtl d ON d.sod_so_nomor = os.Nomor
    WHERE d.sod_jumlah > IFNULL(d.sod_scanned, 0)
    GROUP BY d.sod_kode, d.sod_ukuran
    HAVING qty <> 0;
  `;

  const readyQuery = `
    SELECT mso.mst_brg_kode AS kode, mso.mst_ukuran AS ukuran,
           SUM(mso.mst_stok_in - mso.mst_stok_out) AS qty
    FROM tmasterstokso mso
    WHERE mso.mst_cab = ? AND mso.mst_aktif = 'Y'
    GROUP BY mso.mst_brg_kode, mso.mst_ukuran
    HAVING qty <> 0;
  `;

  const [bookedRows] = await connection.query(bookedQuery, [gudang]);
  const [readyRows] = await connection.query(readyQuery, [gudang]);

  const toMap = (list) => {
    const map = {};
    list.forEach((r) => {
      if (!map[r.kode]) map[r.kode] = {};
      map[r.kode][r.ukuran] = Number(r.qty);
    });
    return map;
  };

  const bookedMap = toMap(bookedRows);
  const readyMap = toMap(readyRows);

  rows.forEach((row) => {
    const bookedDetail = bookedMap[row.kode] || {};
    const readyDetail = readyMap[row.kode] || {};
    row.pesananBookedDetail = bookedDetail;
    row.pesananReadyDetail = readyDetail;
    row.pesananBooked = Object.values(bookedDetail).reduce((a, b) => a + b, 0);
    row.pesananReady = Object.values(readyDetail).reduce((a, b) => a + b, 0);
  });
};

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
      `SELECT DISTINCT brgd_ukuran AS mst_ukuran FROM tbarangdc_dtl ORDER BY brgd_ukuran`,
    );

    let dynamicColumns = "";
    if (sizes.length > 0) {
      dynamicColumns = sizes
        .map((s) => {
          // Escape kutip agar tidak merusak/rawan injeksi lewat label ukuran
          const sizeLabel = s.mst_ukuran.replace(/'/g, "''");
          return `SUM(CASE WHEN s.mst_ukuran = '${sizeLabel}' THEN s.stok ELSE 0 END) AS '${sizeLabel}'`;
        })
        .join(", ");
      dynamicColumns = ", " + dynamicColumns;
    }

    // 3. Mode "toko spesifik" — Pesanan Booked/Ready cuma bermakna untuk 1
    // cabang toko tertentu, dihitung terpisah lewat attachPesananDetail() di bawah.
    const isStoreMode = !!gudang && gudang !== "ALL" && gudang !== "KDC";

    let pesananCTESql = "";
    let pesananSelectSql = ", 0 AS pesananBooked, 0 AS pesananReady";
    let pesananJoinSql = "";
    const pesananParamsPre = [];
    const pesananParamsSelect = [];

    if (isStoreMode) {
      pesananCTESql = `
        WITH open_so AS (
          SELECT Nomor
          FROM (
            SELECT
              y.Nomor,
              CASE
                WHEN y.sts <> 0 THEN 'DICLOSE'
                WHEN y.StatusKirim = 'TERKIRIM' THEN 'CLOSE'
                WHEN y.StatusKirim = 'BELUM' AND y.keluar = 0 AND y.minta = '' AND y.pesan = 0 THEN 'OPEN'
                ELSE 'PROSES'
              END AS StatusFinal
            FROM (
              SELECT
                x.*,
                IF(x.QtyInv = 0, 'BELUM', IF(x.QtyInv >= x.QtySO, 'TERKIRIM', 'SEBAGIAN')) AS StatusKirim,
                IFNULL((
                  SELECT SUM(m.mst_stok_out)
                  FROM tmasterstok m
                  WHERE m.mst_noreferensi IN (
                    SELECT o.mo_nomor FROM tmutasiout_hdr o WHERE o.mo_so_nomor = x.Nomor
                  )
                ), 0) AS keluar,
                IFNULL((
                  SELECT mt_nomor FROM tmintabarang_hdr WHERE mt_so = x.Nomor LIMIT 1
                ), '') AS minta,
                IFNULL((
                  SELECT SUM(mst_stok_in - mst_stok_out)
                  FROM tmasterstokso
                  WHERE mst_aktif = 'Y' AND mst_nomor_so = x.Nomor
                ), 0) AS pesan
              FROM (
                SELECT
                  h.so_nomor AS Nomor,
                  h.so_close AS sts,
                  IFNULL((SELECT SUM(dd.sod_jumlah) FROM tso_dtl dd WHERE dd.sod_so_nomor = h.so_nomor), 0) AS QtySO,
                  IFNULL((
                    SELECT SUM(dd.invd_jumlah)
                    FROM tinv_hdr hh
                    JOIN tinv_dtl dd ON dd.invd_inv_nomor = hh.inv_nomor
                    WHERE hh.inv_sts_pro = 0 AND hh.inv_nomor_so = h.so_nomor
                  ), 0) AS QtyInv
                FROM tso_hdr h
                WHERE h.so_close = 0 AND h.so_aktif = 'Y' AND h.so_cab = ?
              ) x
            ) y
          ) z
          WHERE z.StatusFinal = 'OPEN'
        ),
        pesanan_booked_summary AS (
          SELECT d.sod_kode AS kode, SUM(d.sod_jumlah - IFNULL(d.sod_scanned, 0)) AS booked
          FROM open_so os
          JOIN tso_dtl d ON d.sod_so_nomor = os.Nomor
          WHERE d.sod_jumlah > IFNULL(d.sod_scanned, 0)
          GROUP BY d.sod_kode
        )
      `;
      pesananParamsPre.push(gudang);

      pesananSelectSql = `
        , IFNULL(pb.booked, 0) AS pesananBooked
        , IFNULL((
            SELECT SUM(mso.mst_stok_in - mso.mst_stok_out)
            FROM tmasterstokso mso
            WHERE mso.mst_brg_kode = a.brg_kode AND mso.mst_cab = ? AND mso.mst_aktif = 'Y'
          ), 0) AS pesananReady
      `;
      pesananParamsSelect.push(gudang);

      pesananJoinSql = `LEFT JOIN pesanan_booked_summary pb ON pb.kode = a.brg_kode`;
    }

    // 4. Buffer — ambil dari tbarangdc_dtl2 (per cabang), KECUALI cabang KDC
    // yang memang punya kolom buffer sendiri (brgd_mindc) di tbarangdc_dtl.
    let bufferSubquery = "";
    const bufferParams = [];
    if (gudang === "KDC") {
      bufferSubquery = `IFNULL((SELECT SUM(brgd_mindc) FROM tbarangdc_dtl b WHERE b.brgd_kode = a.brg_kode), 0)`;
    } else if (isStoreMode) {
      bufferSubquery = `IFNULL((SELECT SUM(brgd_min) FROM tbarangdc_dtl2 b2 WHERE b2.brgd_kode = a.brg_kode AND b2.brgd_cab = ?), 0)`;
      bufferParams.push(gudang);
    } else {
      // ALL / gudang kosong: total buffer gabungan semua cabang
      bufferSubquery = `IFNULL((SELECT SUM(brgd_min) FROM tbarangdc_dtl2 b2 WHERE b2.brgd_kode = a.brg_kode), 0)`;
    }

    // 5. Siapkan Parameter Dasar (filter stok per gudang)
    let gudangFilter = "1 = 1";
    const gudangFilterParams = [];
    if (gudang && gudang !== "ALL") {
      gudangFilter = `m.mst_cab = ?`;
      gudangFilterParams.push(gudang);
    }

    // 6. LOGIKA PENCARIAN PINTAR (Multi-Word Search)
    let searchFilter = "";
    const searchParams = [];
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
        searchParams.push(p, p, p, p, p, p); // 6 kolom per kata
      });
    }

    // 7. Susun Array Parameter sesuai URUTAN kemunculan '?' di teks SQL:
    //    CTE Pesanan -> Buffer (SELECT) -> pesananReady (SELECT) -> tanggal/gudang (JOIN) -> search (WHERE)
    const params = [
      ...bufferParams,
      tanggal,
      ...gudangFilterParams,
      ...searchParams,
    ];

    // 8. Query Utama
    const query = `
    SELECT
        a.brg_kode AS kode,
        TRIM(CONCAT_WS(' ', a.brg_jeniskaos, a.brg_tipe, a.brg_lengan, a.brg_jeniskain, a.brg_warna)) AS nama
        ${dynamicColumns}
        , SUM(IFNULL(s.stok, 0)) AS total_stok
        , ${bufferSubquery} AS Buffer
    FROM tbarangdc a
    LEFT JOIN (
        SELECT m.mst_brg_kode, m.mst_ukuran, SUM(m.mst_stok_in - m.mst_stok_out) as stok
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

    // 9. Lengkapi breakdown Pesanan Booked & Ready per ukuran (hanya mode toko spesifik)
    if (isStoreMode) {
      await attachPesananDetail(connection, rows, gudang);
    } else {
      rows.forEach((row) => {
        row.pesananBooked = 0;
        row.pesananReady = 0;
        row.pesananBookedDetail = {};
        row.pesananReadyDetail = {};
      });
    }

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
      return res.status(400).json({
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
