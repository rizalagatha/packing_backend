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

// --- 3. Ranking Performa Cabang (Khusus KDC) ---
const getBranchPerformance = async (req, res) => {
  try {
    const user = req.user;
    // Security check: Hanya KDC yang boleh lihat ranking
    if (user.cabang !== "KDC") return res.json([]);

    const currentMonth = moment().format("M");
    const currentYear = moment().format("YYYY");

    // Query Kompleks: Gabungkan Realisasi Sales vs Target KPI
    const query = `
      SELECT 
        g.gdg_kode as kode_cabang,
        g.gdg_nama as nama_cabang,
        
        -- 1. Realisasi Sales Bulan Ini
        COALESCE((
          SELECT SUM(
             (SELECT SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)) 
              FROM tinv_dtl d WHERE d.invd_inv_nomor = h.inv_nomor) - h.inv_disc
          )
          FROM tinv_hdr h
          WHERE h.inv_cab = g.gdg_kode 
            AND MONTH(h.inv_tanggal) = ? AND YEAR(h.inv_tanggal) = ?
            AND h.inv_sts_pro = 0
        ), 0) as nominal,

        -- 2. Target Sales (Dari tabel target KPI)
        COALESCE((
           SELECT t.target_omset 
           FROM kpi.ttarget_kaosan t 
           WHERE t.kode_gudang = g.gdg_kode 
             AND t.bulan = ? AND t.tahun = ?
           LIMIT 1
        ), 1) as target -- Default 1 biar ga divide by zero

      FROM tgudang g
      WHERE g.gdg_aktif = 'Y' 
        AND g.gdg_kode != 'KDC' -- Exclude Head Office
      ORDER BY nominal DESC
    `;

    const params = [currentMonth, currentYear, currentMonth, currentYear];
    const [rows] = await pool.query(query, params);

    // Hitung % Achievement di JS (atau bisa di SQL)
    const result = rows.map((row) => ({
      ...row,
      ach: (row.nominal / row.target) * 100,
    }));

    // Sort by Achievement % (Opsional, atau biarkan by Nominal)
    result.sort((a, b) => b.ach - a.ach);

    res.json(result);
  } catch (error) {
    console.error("Error getBranchPerformance:", error);
    res.status(500).json({ message: "Gagal memuat performa cabang" });
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
const getPendingActions = async (req, res) => {
  try {
    const user = req.user;
    let branchFilter = "";
    const params = [];

    // Filter cabang (jika bukan KDC)
    // Note: Anda harus sesuaikan nama kolom cabang di tiap tabel (misal: so_cab, pen_cab)
    if (user.cabang !== "KDC") {
      // Logic filter cabang manual per query di bawah
    }

    // A. SO OPEN (Belum diproses invoice)
    // Asumsi: tso_hdr status open
    let soQuery = `SELECT COUNT(*) as cnt FROM tso_hdr WHERE so_close = 0`;
    if (user.cabang !== "KDC")
      soQuery += ` AND LEFT(so_nomor, 3) = '${user.cabang}'`;
    const [soRows] = await pool.query(soQuery);

    // B. Invoice Belum Lunas (Piutang)
    // Logika simpel: ambil dari header yang bayar < total
    // (Atau gunakan logic tpiutang yang lebih akurat)
    let invQuery = `
       SELECT COUNT(DISTINCT u.ph_inv_nomor) as cnt
       FROM tpiutang_hdr u
       JOIN (SELECT pd_ph_nomor, SUM(pd_debet)-SUM(pd_kredit) as sisa FROM tpiutang_dtl GROUP BY pd_ph_nomor) s 
         ON s.pd_ph_nomor = u.ph_nomor
       WHERE s.sisa > 100
    `;
    if (user.cabang !== "KDC")
      invQuery += ` AND LEFT(u.ph_inv_nomor, 3) = '${user.cabang}'`;
    const [invRows] = await pool.query(invQuery);

    // C. SO DTF Pending (Belum jadi Invoice)
    let dtfQuery = `SELECT COUNT(*) as cnt FROM tsodtf_hdr WHERE sd_close = 'N' AND sd_invoiced = 'N'`;
    if (user.cabang !== "KDC")
      dtfQuery += ` AND LEFT(sd_nomor, 3) = '${user.cabang}'`;
    const [dtfRows] = await pool.query(dtfQuery);

    res.json({
      so_open: soRows[0].cnt,
      invoice_belum_lunas: invRows[0].cnt,
      so_dtf_open: dtfRows[0].cnt,
    });
  } catch (error) {
    console.error("Error getPendingActions:", error);
    res.status(500).json({ message: "Gagal memuat pending actions" });
  }
};

module.exports = {
  getTodayStats,
  getTotalPiutang,
  getBranchPerformance,
  getSalesChart,
  getPendingActions,
};
