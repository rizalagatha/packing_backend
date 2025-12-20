const pool = require("../config/database");
const moment = require("moment");
const { format, startOfMonth, endOfMonth } = require("date-fns");

// --- 1. Statistik Hari Ini ---
const getTodayStats = async (req, res) => {
  try {
    const user = req.user;
    const today = moment().format("YYYY-MM-DD");

    let branchFilter = "";
    const params = [today];

    if (user.cabang !== "KDC") {
      branchFilter = " AND h.inv_cab = ? ";
      params.push(user.cabang);
    }

    // Gunakan 2 Query Terpisah (Header & Detail) agar lebih ringan & akurat
    const qHeader = `
        SELECT 
            COUNT(*) as trx, 
            SUM(inv_disc) as disc, 
            SUM(inv_ppn) as ppn 
        FROM tinv_hdr h 
        WHERE h.inv_tanggal = ? 
          AND h.inv_sts_pro = 0 
          ${branchFilter}
    `;

    const qDetail = `
        SELECT 
            SUM(d.invd_jumlah) as qty, 
            SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)) as gross
        FROM tinv_hdr h 
        JOIN tinv_dtl d ON h.inv_nomor = d.invd_inv_nomor
        WHERE h.inv_tanggal = ? 
          AND h.inv_sts_pro = 0 
          AND d.invd_kode NOT LIKE 'JASA%' 
          ${branchFilter}
    `;

    const [headerRows] = await pool.query(qHeader, params);
    const [detailRows] = await pool.query(qDetail, params);

    // --- FIX LOGIC: Casting ke Number secara eksplisit ---
    // MySQL driver kadang mengembalikan Decimal sebagai String, jadi kita paksa ke Number dulu
    const gross = Number(detailRows[0]?.gross) || 0;
    const disc = Number(headerRows[0]?.disc) || 0;
    const ppn = Number(headerRows[0]?.ppn) || 0;

    const stats = {
      todayTransactions: Number(headerRows[0]?.trx) || 0,
      todayQty: Number(detailRows[0]?.qty) || 0,
      todaySales: gross - disc + ppn, // Sekarang operasi matematika pasti aman
    };

    res.json(stats);
  } catch (error) {
    console.error("Error getTodayStats:", error);
    res.status(500).json({ message: "Gagal memuat statistik" });
  }
};

// --- 2. Total Piutang ---
const getTotalPiutang = async (req, res) => {
  try {
    const user = req.user;
    let branchFilter = "";
    const params = [];

    if (user.cabang !== "KDC") {
      branchFilter = " AND LEFT(ph.ph_inv_nomor, 3) = ? ";
      params.push(user.cabang);
    }

    const query = `
      SELECT SUM( GREATEST(0, (SELECT SUM(pd_debet) FROM tpiutang_dtl WHERE pd_ph_nomor = ph.ph_nomor) - (SELECT SUM(pd_kredit) FROM tpiutang_dtl WHERE pd_ph_nomor = ph.ph_nomor)) ) AS totalSisaPiutang
      FROM tpiutang_hdr ph
      WHERE 1=1 ${branchFilter}
    `;
    // Query di atas dioptimalkan agar tidak melakukan JOIN berat jika tabel piutang besar
    const [rows] = await pool.query(query, params);
    res.json({ totalSisaPiutang: rows[0].totalSisaPiutang || 0 });
  } catch (error) {
    console.error("Error getTotalPiutang:", error);
    res.status(500).json({ message: "Gagal memuat piutang" });
  }
};

// --- 3. SALES TARGET SUMMARY (OPTIMALISASI UTAMA) ---
const getSalesTargetSummary = async (req, res) => {
  const user = req.user;
  const tahun = new Date().getFullYear();
  const bulan = new Date().getMonth() + 1;

  // Kita pecah jadi 2 query sederhana (Query Sales & Query Target)
  // lalu gabungkan di JS. Ini JAUH lebih cepat daripada Subquery SQL yang kompleks.

  // A. Query Sales (Gross - Diskon)
  let salesQuery = `
        SELECT 
            -- Total Gross dari Detail
            (SELECT COALESCE(SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)), 0)
             FROM tinv_hdr h
             JOIN tinv_dtl d ON h.inv_nomor = d.invd_inv_nomor
             WHERE h.inv_sts_pro = 0 
               AND YEAR(h.inv_tanggal) = ? AND MONTH(h.inv_tanggal) = ?
               ${user.cabang !== "KDC" ? "AND h.inv_cab = ?" : ""}
            ) 
            - 
            -- Total Diskon dari Header
            (SELECT COALESCE(SUM(h.inv_disc), 0)
             FROM tinv_hdr h
             WHERE h.inv_sts_pro = 0 
               AND YEAR(h.inv_tanggal) = ? AND MONTH(h.inv_tanggal) = ?
               ${user.cabang !== "KDC" ? "AND h.inv_cab = ?" : ""}
            ) as nominal
    `;

  // Params untuk Sales (Ada 2 subquery, jadi params diduplikasi)
  let salesParams = [tahun, bulan];
  if (user.cabang !== "KDC") salesParams.push(user.cabang);
  salesParams = [...salesParams, ...salesParams]; // Duplicate params for second subquery

  // B. Query Target
  let targetQuery = `
        SELECT SUM(t.target_omset) as target
        FROM kpi.ttarget_kaosan t 
        WHERE t.tahun = ? AND t.bulan = ? 
        ${user.cabang !== "KDC" ? "AND t.kode_gudang = ?" : ""}
    `;
  let targetParams = [tahun, bulan];
  if (user.cabang !== "KDC") targetParams.push(user.cabang);

  try {
    // Jalankan Parallel agar cepat
    const [salesResult, targetResult] = await Promise.all([
      pool.query(salesQuery, salesParams),
      pool.query(targetQuery, targetParams),
    ]);

    const nominal = salesResult[0][0].nominal || 0;
    const target = targetResult[0][0].target || 0;

    res.json({ nominal, target });
  } catch (error) {
    console.error("Error getSalesTargetSummary:", error);
    res.status(500).json({ message: "Gagal memuat target" });
  }
};

// --- 4. PERFORMA CABANG (OPTIMALISASI UTAMA) ---
const getBranchPerformance = async (req, res) => {
  const user = req.user;
  if (user.cabang !== "KDC") return res.json([]);

  const tahun = new Date().getFullYear();
  const bulan = new Date().getMonth() + 1;

  // Ganti View 'v_sales_harian' dengan Direct Query agar index 'inv_tanggal' terpakai
  const query = `
        WITH MonthlySales AS (
            SELECT 
                h.inv_cab as cabang, 
                SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)) - SUM(DISTINCT h.inv_disc) AS nominal 
            FROM tinv_hdr h
            JOIN tinv_dtl d ON h.inv_nomor = d.invd_inv_nomor
            WHERE YEAR(h.inv_tanggal) = ? AND MONTH(h.inv_tanggal) = ? AND h.inv_sts_pro = 0
            GROUP BY h.inv_cab
        ),
        MonthlyTargets AS (
            SELECT 
                kode_gudang AS cabang, 
                SUM(target_omset) AS target
            FROM kpi.ttarget_kaosan
            WHERE tahun = ? AND bulan = ?
            GROUP BY cabang
        ),
        MonthlyReturns AS (
            SELECT 
                rh.rj_cab AS cabang,
                SUM(rd.rjd_jumlah * (rd.rjd_harga - rd.rjd_diskon)) AS total_retur
            FROM trj_hdr rh
            JOIN trj_dtl rd ON rd.rjd_nomor = rh.rj_nomor
            WHERE YEAR(rh.rj_tanggal) = ? AND MONTH(rh.rj_tanggal) = ?
            GROUP BY rh.rj_cab
        )
        SELECT 
            g.gdg_kode AS kode_cabang,
            g.gdg_nama AS nama_cabang,
            (COALESCE(ms.nominal, 0) - COALESCE(mr.total_retur, 0)) AS nominal,
            COALESCE(mt.target, 0) AS target,
            CASE 
                WHEN COALESCE(mt.target, 0) > 0 THEN 
                    ((COALESCE(ms.nominal, 0) - COALESCE(mr.total_retur, 0)) / mt.target) * 100 
                ELSE 0 
            END AS ach
        FROM tgudang g
        LEFT JOIN MonthlySales ms ON g.gdg_kode = ms.cabang
        LEFT JOIN MonthlyTargets mt ON g.gdg_kode = mt.cabang
        LEFT JOIN MonthlyReturns mr ON g.gdg_kode = mr.cabang
        WHERE 
            (g.gdg_dc = 0 OR g.gdg_kode = 'KPR') 
            AND g.gdg_kode <> 'KDC'
        ORDER BY ach DESC;
    `;

  const params = [tahun, bulan, tahun, bulan, tahun, bulan];

  try {
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error("Error getBranchPerformance:", error);
    res.status(500).json({ message: "Gagal memuat performa cabang" });
  }
};

// --- 5. Chart Data ---
const getSalesChart = async (req, res) => {
  try {
    const { startDate, endDate, groupBy, cabang } = req.query;
    const user = req.user;

    let branchCondition = "";
    const params = [startDate, endDate];

    if (user.cabang !== "KDC") {
      branchCondition = " AND h.inv_cab = ? ";
      params.push(user.cabang);
    } else if (cabang && cabang !== "ALL") {
      branchCondition = " AND h.inv_cab = ? ";
      params.push(cabang);
    }

    let dateSelect = "DATE(h.inv_tanggal)";
    if (groupBy === "month")
      dateSelect = "DATE_FORMAT(h.inv_tanggal, '%Y-%m-01')";

    const query = `
      SELECT 
        ${dateSelect} as tanggal,
        -- Hitung Gross Item dikurangi Header Diskon (diproporasi atau grouping)
        -- Cara cepat: Sum(Gross) - Sum(Diskon Header) per hari
        (
            (SELECT SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)) 
             FROM tinv_dtl d WHERE d.invd_inv_nomor IN (SELECT inv_nomor FROM tinv_hdr WHERE DATE(inv_tanggal) = DATE(h.inv_tanggal)))
             -
             SUM(h.inv_disc)
        ) as total
      FROM tinv_hdr h
      WHERE h.inv_tanggal BETWEEN ? AND ?
        AND h.inv_sts_pro = 0
        ${branchCondition}
      GROUP BY ${dateSelect}
      ORDER BY tanggal ASC
    `;
    // NOTE: Query Chart di atas masih sedikit berat, tapi karena dilimit tanggal (startDate-endDate), harusnya aman.

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error("Error getSalesChart:", error);
    res.status(500).json({ message: "Gagal memuat grafik" });
  }
};

// --- 6. Pending Actions (Stok Kosong) ---
const getPendingActions = async (req, res) => {
  const user = req.user;
  let branchToCheck = user.cabang;

  const query = `
      SELECT COUNT(*) AS total_kosong 
      FROM (
          SELECT m.mst_brg_kode
          FROM tmasterstok m
          JOIN tbarangdc a ON a.brg_kode = m.mst_brg_kode
          WHERE m.mst_aktif = 'Y' 
            AND m.mst_cab = ? 
            AND a.brg_ktgp = 'REGULER'
          GROUP BY m.mst_brg_kode, m.mst_ukuran
          HAVING SUM(m.mst_stok_in - m.mst_stok_out) <= 0
      ) AS summary_stok;
    `;

  try {
    const [rows] = await pool.query(query, [branchToCheck]);
    res.json({
      stok_kosong_reguler: rows[0]?.total_kosong || 0,
      so_open: 0,
      invoice_belum_lunas: 0,
    });
  } catch (error) {
    console.error("Error getPendingActions:", error);
    res.json({ stok_kosong_reguler: 0 });
  }
};

// --- 7. List Sisa Piutang per Cabang (KDC Only) ---
const getPiutangPerCabang = async (req, res) => {
  const user = req.user;
  if (user.cabang !== "KDC") return res.json([]);

  try {
    const query = `
            SELECT 
                u.ph_cab AS cabang_kode,
                g.gdg_nama AS cabang_nama,
                SUM(v.debet - v.kredit) AS sisa_piutang
            FROM tpiutang_hdr u
            LEFT JOIN (
                SELECT pd_ph_nomor, SUM(pd_debet) AS debet, SUM(pd_kredit) AS kredit 
                FROM tpiutang_dtl GROUP BY pd_ph_nomor
            ) v ON v.pd_ph_nomor = u.ph_nomor
            LEFT JOIN tgudang g ON g.gdg_kode = u.ph_cab
            WHERE (v.debet - v.kredit) > 0
            GROUP BY u.ph_cab, g.gdg_nama
            ORDER BY sisa_piutang DESC;
        `;
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (error) {
    console.error("Error getPiutangPerCabang:", error);
    res.status(500).json({ message: "Gagal memuat list piutang" });
  }
};

// --- 8. Detail Invoice Piutang per Cabang (FIXED) ---
const getBranchPiutangDetail = async (req, res) => {
  const { cabang } = req.params;
  try {
    const query = `
        SELECT 
            u.ph_inv_nomor AS invoice,
            DATE_FORMAT(h.inv_tanggal, '%Y-%m-%d') AS tanggal,
            IFNULL(v.debet - v.kredit, 0) AS sisa_piutang,
            
            -- FIX: Hanya ambil dari tcustomer. Jika null (tidak ketemu), set 'Customer Umum'
            IFNULL(c.cus_nama, 'Customer Umum') AS nama_customer

        FROM tpiutang_hdr u
        LEFT JOIN (
            SELECT pd_ph_nomor, SUM(pd_debet) AS debet, SUM(pd_kredit) AS kredit 
            FROM tpiutang_dtl GROUP BY pd_ph_nomor
        ) v ON v.pd_ph_nomor = u.ph_nomor
        LEFT JOIN tinv_hdr h ON h.inv_nomor = u.ph_inv_nomor
        LEFT JOIN tcustomer c ON c.cus_kode = h.inv_cus_kode -- JOIN yang benar
        WHERE u.ph_cab = ? AND (v.debet - v.kredit) > 0
        ORDER BY sisa_piutang DESC;
    `;
    const [rows] = await pool.query(query, [cabang]);
    res.json(rows);
  } catch (error) {
    console.error("Error getBranchPiutangDetail:", error);
    res.status(500).json({ message: error.message });
  }
};

// --- 9. Top Selling Products (Referensi Anda) ---
const getTopSellingProducts = async (req, res) => {
  const { cabang: userCabang } = req.user; // Ambil cabang dari token user
  const { branchFilter } = req.query; // Ambil filter dari frontend (?branchFilter=K01)

  try {
    // 1. Tentukan Range Tanggal (Awal Bulan - Akhir Bulan ini)
    const startDate = format(startOfMonth(new Date()), "yyyy-MM-dd");
    const endDate = format(endOfMonth(new Date()), "yyyy-MM-dd");

    let targetCabang = null;

    // 2. LOGIKA PENENTUAN CABANG (Sesuai Referensi)
    if (userCabang === "KDC") {
      // Jika KDC, cek apakah ada filter dari frontend?
      if (branchFilter && branchFilter !== "ALL") {
        targetCabang = branchFilter;
      }
      // Jika filter kosong atau 'ALL', targetCabang tetap null (ambil semua)
    } else {
      // Jika bukan KDC, paksa pakai cabang user sendiri
      targetCabang = userCabang;
    }

    // 3. QUERY UTAMA (Sesuai Referensi)
    let query = `
        SELECT 
            d.invd_kode AS KODE,
            TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS NAMA,
            d.invd_ukuran AS UKURAN, 
            SUM(d.invd_jumlah) AS TOTAL
        FROM tinv_hdr h
        INNER JOIN tinv_dtl d ON d.invd_inv_nomor = h.inv_nomor
        INNER JOIN tbarangdc a ON a.brg_kode = d.invd_kode
        WHERE h.inv_sts_pro = 0 
          AND h.inv_tanggal BETWEEN ? AND ?
          AND a.brg_logstok = "Y"
    `;

    const params = [startDate, endDate];

    // 4. TERAPKAN FILTER CABANG JIKA ADA
    if (targetCabang) {
      query += ` AND h.inv_cab = ? `;
      params.push(targetCabang);
    }

    // 5. GROUPING & SORTING
    query += `
        GROUP BY d.invd_kode, NAMA, d.invd_ukuran
        ORDER BY TOTAL DESC
        LIMIT 10;
    `;

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error getTopSellingProducts:", error);
    res.status(500).json({ message: error.message });
  }
};

// --- 10. Cek Stok Detail (FIXED: Menggunakan tmasterstok) ---
const getProductStockSpread = async (req, res) => {
  const { barcode } = req.params;
  const { ukuran } = req.query; // Kita terima parameter ukuran (opsional) agar akurat

  try {
    // Query Perhitungan Stok Real-time dari tmasterstok
    // Rumus: SUM(Masuk - Keluar)
    let query = `
       SELECT 
         m.mst_cab AS cabang,
         IFNULL(g.gdg_nama, m.mst_cab) AS nama_cabang, -- Ambil nama gudang, jika null pakai kode
         SUM(m.mst_stok_in - m.mst_stok_out) AS qty
       FROM tmasterstok m
       LEFT JOIN tgudang g ON g.gdg_kode = m.mst_cab
       WHERE m.mst_brg_kode = ? 
         AND m.mst_aktif = 'Y'
    `;

    const params = [barcode];

    // Jika ada filter ukuran (dikirim dari frontend), tambahkan ke kondisi
    // Ini penting agar stok yang muncul sesuai dengan ukuran yang diklik di chart
    if (ukuran) {
      query += ` AND m.mst_ukuran = ? `;
      params.push(ukuran);
    }

    query += `
       GROUP BY m.mst_cab
       HAVING qty > 0 -- Hanya tampilkan cabang yang stoknya ada (positif)
       ORDER BY qty DESC
    `;

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error getProductStockSpread:", error);
    res.status(500).json({ message: error.message });
  }
};

// --- 11. Analisa Tren Produk (Kain & Lengan) ---
const getProductTrends = async (req, res) => {
  const { cabang: userCabang } = req.user;
  const { branchFilter } = req.query;

  try {
    const startDate = format(startOfMonth(new Date()), "yyyy-MM-dd");
    const endDate = format(endOfMonth(new Date()), "yyyy-MM-dd");

    let targetCabang = null;
    if (userCabang === "KDC") {
      if (branchFilter && branchFilter !== "ALL") targetCabang = branchFilter;
    } else {
      targetCabang = userCabang;
    }

    // Helper untuk menyusun query agar tidak duplikasi kodingan
    const buildQuery = (groupByColumn) => {
      let sql = `
        SELECT 
            IFNULL(${groupByColumn}, 'LAINNYA') AS kategori,
            SUM(d.invd_jumlah) AS total_qty
        FROM tinv_hdr h
        JOIN tinv_dtl d ON d.invd_inv_nomor = h.inv_nomor
        JOIN tbarangdc a ON a.brg_kode = d.invd_kode
        WHERE h.inv_sts_pro = 0 
          AND h.inv_tanggal BETWEEN ? AND ?
          AND a.brg_logstok = "Y"
      `;

      const params = [startDate, endDate];

      if (targetCabang) {
        sql += ` AND h.inv_cab = ? `;
        params.push(targetCabang);
      }

      // UPDATE DISINI: Tambahkan LIMIT 5
      sql += ` 
        GROUP BY ${groupByColumn} 
        ORDER BY total_qty DESC 
        LIMIT 5 
      `;

      return { sql, params };
    };

    // 1. Query Kain
    const qKain = buildQuery('a.brg_jeniskain');
    const [resKain] = await pool.query(qKain.sql, qKain.params);

    // 2. Query Lengan
    const qLengan = buildQuery('a.brg_lengan');
    const [resLengan] = await pool.query(qLengan.sql, qLengan.params);

    res.json({
      success: true,
      data: {
        kain: resKain,
        lengan: resLengan
      }
    });

  } catch (error) {
    console.error("Error getProductTrends:", error);
    res.status(500).json({ message: error.message });
  }
};

// --- 12. Laporan Stok Kosong Reguler ---
// --- 12. Laporan Stok Kosong Reguler ---
const getEmptyStockReguler = async (req, res) => {
  const { cabang: userCabang } = req.user;
  const { search = "", targetCabang = "" } = req.query;

  try {
    let branchToCheck = userCabang;
    if (userCabang === "KDC" && targetCabang && targetCabang !== "ALL") {
      branchToCheck = targetCabang;
    }

    const searchPattern = `%${search}%`;

    // VERSI FIX: Menghapus komentar SQL (--) agar aman dari Syntax Error
    const query = `
        SELECT 
            b.brgd_kode AS kode,
            b.brgd_barcode AS barcode,
            TRIM(CONCAT(a.brg_jeniskaos, ' ', a.brg_tipe, ' ', a.brg_lengan, ' ', a.brg_jeniskain, ' ', a.brg_warna)) AS nama_barang,
            b.brgd_ukuran AS ukuran,
            a.brg_ktgp AS kategori,
            COALESCE(stok.sisa, 0) AS stok_akhir
        FROM tbarangdc_dtl b
        INNER JOIN tbarangdc a ON a.brg_kode = b.brgd_kode
        LEFT JOIN (
            SELECT mst_brg_kode, mst_ukuran, (mst_stok_in - mst_stok_out) as sisa
            FROM tmasterstok
            WHERE mst_cab = ? AND mst_aktif = 'Y'
        ) stok ON stok.mst_brg_kode = b.brgd_kode AND stok.mst_ukuran = b.brgd_ukuran
        WHERE 
          a.brg_aktif = 'Y' 
          AND a.brg_ktgp = 'REGULER'
          AND (
              b.brgd_kode LIKE ? 
              OR b.brgd_barcode LIKE ?
              OR TRIM(CONCAT(a.brg_jeniskaos, ' ', a.brg_tipe, ' ', a.brg_lengan, ' ', a.brg_jeniskain, ' ', a.brg_warna)) LIKE ?
          )
          AND COALESCE(stok.sisa, 0) <= 0 
        ORDER BY nama_barang, ukuran
        LIMIT 50
    `;

    // Urutan parameter: [cabang, search, search, search]
    const params = [branchToCheck, searchPattern, searchPattern, searchPattern];
    
    const [rows] = await pool.query(query, params);

    res.json({ success: true, data: rows });

  } catch (error) {
    console.error("Error getEmptyStockReguler:", error);
    res.status(500).json({ message: error.message });
  }
};

// --- 13. Sebaran Penjualan Produk (Sales Spread) ---
const getProductSalesSpread = async (req, res) => {
  const { kode, ukuran } = req.query;
  const user = req.user;

  try {
    // 1. Determine Date Range (Current Month)
    const startDate = format(startOfMonth(new Date()), "yyyy-MM-dd");
    const endDate = format(endOfMonth(new Date()), "yyyy-MM-dd");

    // 2. Query Sales Distribution
    let query = `
        SELECT 
            h.inv_cab AS cabang,
            IFNULL(g.gdg_nama, h.inv_cab) AS nama_cabang,
            SUM(d.invd_jumlah) AS qty
        FROM tinv_dtl d
        JOIN tinv_hdr h ON h.inv_nomor = d.invd_inv_nomor
        LEFT JOIN tgudang g ON g.gdg_kode = h.inv_cab
        WHERE d.invd_kode = ?
          AND h.inv_sts_pro = 0
          AND h.inv_tanggal BETWEEN ? AND ?
    `;

    const params = [kode, startDate, endDate];

    if (ukuran) {
        query += ` AND d.invd_ukuran = ? `;
        params.push(ukuran);
    }

    query += `
        GROUP BY h.inv_cab, g.gdg_nama
        ORDER BY qty DESC
    `;

    const [rows] = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
    });

  } catch (error) {
    console.error("Error getProductSalesSpread:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getTodayStats,
  getTotalPiutang,
  getSalesTargetSummary,
  getBranchPerformance,
  getSalesChart,
  getPendingActions,
  getPiutangPerCabang,
  getBranchPiutangDetail,
  getTopSellingProducts,
  getProductStockSpread,
  getProductTrends,
  getEmptyStockReguler,
  getProductSalesSpread,
};
