const pool = require("../config/database"); // Sesuaikan path config DB Anda
const moment = require("moment"); // Pastikan install moment: npm install moment

// --- 1. Statistik Hari Ini (Omset, Qty, Transaksi) ---
const getTodayStats = async (req, res) => {
  try {
    const user = req.user;
    const today = moment().format("YYYY-MM-DD");

    // Filter Cabang (KDC lihat semua, Cabang lihat sendiri)
    let branchFilter = "";
    const params = [today];

    if (user.cabang !== "KDC") {
      branchFilter = " AND h.inv_cab = ? ";
      params.push(user.cabang);
    }

    const query = `
      SELECT 
        COUNT(DISTINCT h.inv_nomor) AS todayTransactions,
        -- Total Qty (Hanya barang stok, exclude Jasa)
        COALESCE(SUM((
            SELECT SUM(d.invd_jumlah) 
            FROM tinv_dtl d 
            WHERE d.invd_inv_nomor = h.inv_nomor 
              AND d.invd_kode NOT LIKE 'JASA%'
        )), 0) AS todayQty,
        -- Total Omset (Netto)
        COALESCE(SUM(
            (SELECT SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)) 
             FROM tinv_dtl d WHERE d.invd_inv_nomor = h.inv_nomor) 
            - h.inv_disc
            + h.inv_ppn -- (Simplified tax calc, sesuaikan jika logic pajak anda beda)
        ), 0) AS todaySales
      FROM tinv_hdr h
      WHERE h.inv_tanggal = ? 
        AND h.inv_sts_pro = 0 -- Pastikan invoice valid/tidak batal
        ${branchFilter}
    `;

    const [rows] = await pool.query(query, params);
    res.json(rows[0]);
  } catch (error) {
    console.error("Error getTodayStats:", error);
    res.status(500).json({ message: "Gagal memuat statistik hari ini" });
  }
};

// --- 2. Total Piutang (Global / Per Cabang) ---
const getTotalPiutang = async (req, res) => {
  try {
    const user = req.user;
    let branchFilter = "";
    const params = [];

    if (user.cabang !== "KDC") {
      branchFilter = " AND LEFT(ph.ph_inv_nomor, 3) = ? "; // Asumsi 3 digit awal no invoice = kode cabang
      params.push(user.cabang);
    }

    // Hitung Sisa: Debet - Kredit
    const query = `
      SELECT 
        SUM(GREATEST(0, sub.debet - sub.kredit)) AS totalSisaPiutang
      FROM tpiutang_hdr ph
      JOIN (
        SELECT pd_ph_nomor, SUM(pd_debet) as debet, SUM(pd_kredit) as kredit
        FROM tpiutang_dtl
        GROUP BY pd_ph_nomor
      ) sub ON sub.pd_ph_nomor = ph.ph_nomor
      WHERE 1=1 ${branchFilter}
    `;

    const [rows] = await pool.query(query, params);
    res.json({ totalSisaPiutang: rows[0].totalSisaPiutang || 0 });
  } catch (error) {
    console.error("Error getTotalPiutang:", error);
    res.status(500).json({ message: "Gagal memuat piutang" });
  }
};

// 1. UPDATE FUNGSI INI (Untuk Grafik Pencapaian Target)
const getSalesTargetSummary = async (user) => {
  const tahun = new Date().getFullYear();
  const bulan = new Date().getMonth() + 1;

  let branchFilter = "AND h.inv_cab = ?";
  // Urutan params: [Tahun Target, Bulan Target, (Cabang Target), Tahun Jual, Bulan Jual, (Cabang Jual)]
  // Kita sederhanakan agar tidak bingung
  
  let targetQueryPart = "";
  let salesQueryPart = "";
  let params = [];

  // --- A. BUILD PARAMS UNTUK TARGET ---
  params.push(tahun, bulan);
  if (user.cabang !== "KDC") {
    targetQueryPart = "AND t.kode_gudang = ?";
    params.push(user.cabang);
  }

  // --- B. BUILD PARAMS UNTUK SALES ---
  params.push(tahun, bulan);
  if (user.cabang !== "KDC") {
    salesQueryPart = "AND h.inv_cab = ?";
    params.push(user.cabang);
  }

  const query = `
    SELECT 
        -- 1. Hitung Nominal (Sales - Diskon)
        IFNULL(
            (
              SELECT SUM(
                  (SELECT SUM(dd.invd_jumlah * (dd.invd_harga - dd.invd_diskon)) 
                   FROM tinv_dtl dd WHERE dd.invd_inv_nomor = h.inv_nomor) - h.inv_disc
              ) 
              FROM tinv_hdr h
              WHERE h.inv_sts_pro = 0 
                AND YEAR(h.inv_tanggal) = ? 
                AND MONTH(h.inv_tanggal) = ?
                ${salesQueryPart}
            ), 0
        ) AS nominal,

        -- 2. Ambil Target
        IFNULL(
            (
                SELECT SUM(t.target_omset) 
                FROM kpi.ttarget_kaosan t 
                WHERE t.tahun = ? AND t.bulan = ? 
                ${targetQueryPart}
            ), 0
        ) AS target
  `;
  
  // Perhatikan urutan params harus sesuai dengan urutan '?' di query
  // Urutan: [Tahun Jual, Bulan Jual, (Cabang Jual), Tahun Target, Bulan Target, (Cabang Target)]
  // Kita susun ulang params agar sesuai query di atas
  
  let finalParams = [tahun, bulan];
  if (user.cabang !== "KDC") finalParams.push(user.cabang);
  
  finalParams.push(tahun, bulan);
  if (user.cabang !== "KDC") finalParams.push(user.cabang);

  const [rows] = await pool.query(query, finalParams);
  return rows[0];
};

// 2. UPDATE FUNGSI INI (Untuk Tabel Performa Cabang - Logika Retur)
const getBranchPerformance = async (user) => {
  if (user.cabang !== "KDC") return [];

  const tahun = new Date().getFullYear();
  const bulan = new Date().getMonth() + 1;

  const query = `
        WITH MonthlySales AS (
            SELECT 
                cabang, 
                SUM(nominal) AS nominal 
            FROM v_sales_harian
            WHERE YEAR(tanggal) = ? AND MONTH(tanggal) = ?
            GROUP BY cabang
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
            -- Nominal Bersih = Sales - Retur
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
    return rows;
  } catch (error) {
    console.error("Error getBranchPerformance:", error);
    return [];
  }
};

// --- 4. Chart Data (Sales Trend) ---
const getSalesChart = async (req, res) => {
  try {
    const { startDate, endDate, groupBy, cabang } = req.query;
    const user = req.user;

    let branchCondition = "";
    const params = [startDate, endDate];

    // Filter Cabang untuk Chart
    if (user.cabang !== "KDC") {
      branchCondition = " AND h.inv_cab = ? ";
      params.push(user.cabang);
    } else if (cabang && cabang !== "ALL") {
      branchCondition = " AND h.inv_cab = ? ";
      params.push(cabang);
    }

    // Grouping Logic
    let dateSelect = "DATE(h.inv_tanggal)";
    if (groupBy === "month")
      dateSelect = "DATE_FORMAT(h.inv_tanggal, '%Y-%m-01')";

    const query = `
      SELECT 
        ${dateSelect} as tanggal,
        SUM(
           (SELECT SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)) 
            FROM tinv_dtl d WHERE d.invd_inv_nomor = h.inv_nomor) - h.inv_disc
        ) as total
      FROM tinv_hdr h
      WHERE h.inv_tanggal BETWEEN ? AND ?
        AND h.inv_sts_pro = 0
        ${branchCondition}
      GROUP BY ${dateSelect}
      ORDER BY tanggal ASC
    `;

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error("Error getSalesChart:", error);
    res.status(500).json({ message: "Gagal memuat grafik" });
  }
};

// --- 5. Pending Actions (Notifikasi) ---
// GANTI FUNGSI INI DI BACKEND
const getPendingActions = async (user) => {
  // Kita ganti logika "Pending Action" menjadi "Info Stok Kosong Reguler"

  // Tentukan cabang yang mau dicek (Default: cabang user login)
  // Jika KDC, kita bisa default ke salah satu cabang atau tetap KDC (biasanya KDC stoknya dikit)
  let branchToCheck = user.cabang;

  // Query: Hitung jumlah SKU (Barang + Ukuran) yang stoknya <= 0
  // Kategori: REGULER, Barang Aktif: Ya (0 artinya aktif di sistem Anda sepertinya, berdasarkan getStokKosongReguler)
  const query = `
    SELECT COUNT(*) AS total_kosong 
    FROM (
        SELECT 
            m.mst_brg_kode,
            m.mst_ukuran
        FROM tmasterstok m
        JOIN tbarangdc a ON a.brg_kode = m.mst_brg_kode
        WHERE m.mst_aktif = 'Y' 
          AND m.mst_cab = ? 
          AND a.brg_ktgp = 'REGULER' -- Filter Kategori di awal biar scan lebih sedikit
        GROUP BY m.mst_brg_kode, m.mst_ukuran
        HAVING SUM(m.mst_stok_in - m.mst_stok_out) <= 0
    ) AS summary_stok;
  `;

  try {
    const [rows] = await pool.query(query, [branchToCheck]);

    // Kembalikan format object baru
    return {
      stok_kosong_reguler: rows[0].total_kosong || 0,
      // Field lama kita set 0 atau null biar frontend lama gak error (opsional)
      so_open: 0,
      invoice_belum_lunas: 0,
    };
  } catch (error) {
    console.error("Error getPendingActions (Stok Kosong):", error);
    return { stok_kosong_reguler: 0 };
  }
};

module.exports = {
  getTodayStats,
  getTotalPiutang,
  getSalesTargetSummary,
  getBranchPerformance,
  getSalesChart,
  getPendingActions,
};
