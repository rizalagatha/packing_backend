const pool = require("../config/database");
const moment = require("moment");
const { format, startOfMonth, endOfMonth } = require("date-fns");

// Helper untuk filter cabang dinamis
// Jika user KDC dan kirim filterCabang, gunakan filter tersebut.
// Jika user BUKAN KDC, paksa gunakan cabang user sendiri.
const getBranchFilter = (
  user,
  queryFilter,
  tableAlias = "h",
  column = "inv_cab"
) => {
  let filter = "";
  let params = [];

  if (user.cabang !== "KDC") {
    // User Cabang: Hanya bisa lihat cabangnya sendiri
    filter = ` AND ${tableAlias}.${column} = ? `;
    params.push(user.cabang);
  } else if (queryFilter && queryFilter !== "ALL") {
    // User KDC + Ada Filter: Lihat cabang spesifik
    filter = ` AND ${tableAlias}.${column} = ? `;
    params.push(queryFilter);
  }
  // User KDC + No Filter: Lihat Semua (Tidak ada WHERE tambahan)

  return { filter, params };
};

// --- 1. Statistik Hari Ini ---
const getTodayStats = async (req, res) => {
  try {
    const user = req.user;
    const { cabang } = req.query;
    const today = moment().format("YYYY-MM-DD");
    const isKDC = user.cabang === "KDC";
    const excludePattern = "^K[0-9]{2}\\.(SD|BR|PM|DP|TG|PL|SB)\\.";

    let branchFilter = "AND h.inv_cab = ?";
    let params = [excludePattern, today, today];

    if (isKDC) {
      if (cabang && cabang !== "ALL") {
        branchFilter = "AND h.inv_cab = ?";
        params.push(cabang);
      } else {
        branchFilter = "";
      }
    } else {
      params.push(user.cabang);
    }

    const query = `
      SELECT
        COUNT(DISTINCT h.inv_nomor) AS trx,
        -- Menggunakan COALESCE agar nilai NULL tidak membuat hasil SUM menjadi NULL/0
        -- Menggunakan ROUND untuk menghilangkan margin desimal ribuan
        ROUND(SUM(
            (SELECT SUM(dd.invd_jumlah * (dd.invd_harga - dd.invd_diskon)) 
             FROM tinv_dtl dd WHERE dd.invd_inv_nomor = h.inv_nomor) 
            - COALESCE(h.inv_disc, 0) 
            + (COALESCE(h.inv_ppn, 0) / 100 * (
                (SELECT SUM(dd.invd_jumlah * (dd.invd_harga - dd.invd_diskon)) 
                 FROM tinv_dtl dd WHERE dd.invd_inv_nomor = h.inv_nomor) - COALESCE(h.inv_disc, 0)
              ))
            + COALESCE(h.inv_bkrm, 0)
        ), 0) AS todaySales,
        
        IFNULL(SUM(
          (SELECT SUM(dd.invd_jumlah) FROM tinv_dtl dd 
           WHERE dd.invd_inv_nomor = h.inv_nomor
             AND dd.invd_kode NOT LIKE 'JASA%' 
             AND dd.invd_kode NOT REGEXP ?)
        ), 0) AS todayQty
      FROM tinv_hdr h
      WHERE h.inv_sts_pro = 0 
        AND h.inv_tanggal BETWEEN ? AND ?
        ${branchFilter};
    `;

    const [rows] = await pool.query(query, params);
    res.json({
      todayTransactions: Number(rows[0].trx) || 0,
      todayQty: Number(rows[0].todayQty) || 0,
      todaySales: Number(rows[0].todaySales) || 0,
    });
  } catch (error) {
    res.status(500).json({ message: "Gagal memuat statistik" });
  }
};

// --- 2. Total Piutang ---
const getTotalPiutang = async (req, res) => {
  try {
    const user = req.user;
    const { cabang } = req.query;
    let branchFilter = "";
    let params = [];

    if (user.cabang !== "KDC") {
      branchFilter = " AND ph.ph_cab = ? ";
      params.push(user.cabang);
    } else if (cabang && cabang !== "ALL") {
      branchFilter = " AND ph.ph_cab = ? ";
      params.push(cabang);
    }

    const query = `
      SELECT 
        -- ROUND dan COALESCE untuk akurasi ribuan
        ROUND(SUM(GREATEST(0, IFNULL(v.debet, 0) - IFNULL(v.kredit, 0))), 0) AS totalSisaPiutang
      FROM tpiutang_hdr ph
      LEFT JOIN (
          SELECT pd_ph_nomor, 
                 SUM(pd_debet) AS debet, 
                 SUM(pd_kredit) AS kredit 
          FROM tpiutang_dtl 
          GROUP BY pd_ph_nomor
      ) v ON v.pd_ph_nomor = ph.ph_nomor
      WHERE 1=1 ${branchFilter}
    `;

    const [rows] = await pool.query(query, params);
    res.json({ totalSisaPiutang: Number(rows[0].totalSisaPiutang) || 0 });
  } catch (error) {
    res.status(500).json({ message: "Gagal memuat piutang" });
  }
};

// --- 3. SALES TARGET SUMMARY (OPTIMALISASI UTAMA) ---
const getSalesTargetSummary = async (req, res) => {
  const { cabang } = req.query;
  const user = req.user;
  const tahun = new Date().getFullYear();
  const bulan = new Date().getMonth() + 1;

  let branchFilterInv = "";
  let branchFilterRj = "";
  let branchFilterTgt = "";
  let params = [tahun, bulan, tahun, bulan, tahun, bulan];

  if (user.cabang !== "KDC" || (cabang && cabang !== "ALL")) {
    const targetCab = cabang && cabang !== "ALL" ? cabang : user.cabang;
    branchFilterInv = `AND inv_cab = '${targetCab}'`;
    branchFilterRj = `AND rj_cab = '${targetCab}'`;
    branchFilterTgt = `AND kode_gudang = '${targetCab}'`;
  }

  const query = `
    SELECT 
        (
          -- Sales Netto
          (SELECT ROUND(SUM(gross - disc_hdr - mp_fee), 0) FROM (
            SELECT 
                (SELECT SUM(invd_jumlah * (invd_harga - invd_diskon)) FROM tinv_dtl WHERE invd_inv_nomor = inv_nomor) as gross,
                COALESCE(inv_disc, 0) as disc_hdr,
                COALESCE(inv_mp_biaya_platform, 0) as mp_fee
            FROM tinv_hdr 
            WHERE YEAR(inv_tanggal) = ? AND MONTH(inv_tanggal) = ? AND inv_sts_pro = 0 ${branchFilterInv}
          ) s)
          -
          -- Kurangi Retur
          COALESCE((SELECT ROUND(SUM(rd.rjd_jumlah * (rd.rjd_harga - rd.rjd_diskon)), 0)
           FROM trj_hdr rh JOIN trj_dtl rd ON rd.rjd_nomor = rh.rj_nomor
           WHERE YEAR(rh.rj_tanggal) = ? AND MONTH(rh.rj_tanggal) = ? ${branchFilterRj}), 0)
        ) AS nominal,

        -- Target
        COALESCE((SELECT SUM(target_omset) FROM kpi.ttarget_kaosan 
         WHERE tahun = ? AND bulan = ? ${branchFilterTgt}), 0) AS target
  `;

  try {
    const [rows] = await pool.query(query, params);
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Gagal" });
  }
};

// --- 4. PERFORMA CABANG (OPTIMALISASI UTAMA) ---
const getBranchPerformance = async (req, res) => {
  const user = req.user;
  if (user.cabang !== "KDC") return res.json([]);

  const tahun = new Date().getFullYear();
  const bulan = new Date().getMonth() + 1;

  const query = `
    WITH 
    -- 1. Hitung Netto per Invoice (Gross Items - Disc Header - MP Fee)
    -- Group by inv_nomor mencegah duplikasi diskon/biaya
    InvoiceNetto AS (
        SELECT 
            h.inv_cab AS cabang,
            ROUND(
                SUM((d.invd_harga - d.invd_diskon) * d.invd_jumlah) 
                - COALESCE(h.inv_disc, 0)
                - COALESCE(h.inv_mp_biaya_platform, 0)
            , 0) AS nominal_invoice
        FROM tinv_hdr h
        JOIN tinv_dtl d ON h.inv_nomor = d.invd_inv_nomor
        WHERE YEAR(h.inv_tanggal) = ? AND MONTH(h.inv_tanggal) = ? 
          AND h.inv_sts_pro = 0
        GROUP BY h.inv_nomor
    ),

    -- 2. Hitung Retur per Cabang
    ReturNetto AS (
        SELECT 
            rh.rj_cab AS cabang,
            ROUND(SUM(rd.rjd_jumlah * (rd.rjd_harga - rd.rjd_diskon)), 0) AS nominal_retur
        FROM trj_hdr rh
        JOIN trj_dtl rd ON rh.rj_nomor = rd.rjd_nomor
        WHERE YEAR(rh.rj_tanggal) = ? AND MONTH(rh.rj_tanggal) = ?
        GROUP BY rh.rj_cab
    ),

    -- 3. Target per Cabang
    TargetData AS (
        SELECT kode_gudang AS cabang, SUM(target_omset) AS target
        FROM kpi.ttarget_kaosan
        WHERE tahun = ? AND bulan = ?
        GROUP BY cabang
    ),

    -- 4. Gabungkan Sales per Cabang
    FinalSales AS (
        SELECT cabang, SUM(nominal_invoice) AS total_sales
        FROM InvoiceNetto
        GROUP BY cabang
    )

    -- 5. Hasil Akhir (Sales - Retur)
    SELECT 
        g.gdg_kode AS kode_cabang,
        g.gdg_nama AS nama_cabang,
        COALESCE(fs.total_sales, 0) - COALESCE(mr.nominal_retur, 0) AS nominal,
        COALESCE(td.target, 0) AS target,
        CASE 
            WHEN COALESCE(td.target, 0) > 0 THEN 
                ((COALESCE(fs.total_sales, 0) - COALESCE(mr.nominal_retur, 0)) / td.target) * 100 
            ELSE 0 
        END AS ach
    FROM tgudang g
    LEFT JOIN FinalSales fs ON g.gdg_kode = fs.cabang
    LEFT JOIN ReturNetto mr ON g.gdg_kode = mr.cabang
    LEFT JOIN TargetData td ON g.gdg_kode = td.cabang
    WHERE (g.gdg_dc = 0 OR g.gdg_kode = 'KPR' OR g.gdg_kode = 'KON') 
      AND g.gdg_kode <> 'KDC'
    ORDER BY ach DESC;
  `;

  // Urutan Parameter: Sales(Y,M), Retur(Y,M), Target(Y,M)
  const params = [tahun, bulan, tahun, bulan, tahun, bulan];

  try {
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error("Error getBranchPerformance:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat performa cabang" });
  }
};

// --- 5. Chart Data ---
const getSalesChart = async (req, res) => {
  try {
    const { startDate, endDate, groupBy, cabang } = req.query; // Ensure 'cabang' is read
    const user = req.user;

    let branchCondition = "";
    const params = [startDate, endDate];

    // LOGIC FIX: Prioritize User Branch, then Filter
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

    // LOG FOR DEBUGGING BACKEND (Optional, check your terminal)
    // console.log("Chart Filter:", cabang, "Condition:", branchCondition);

    const query = `
      SELECT 
        ${dateSelect} as tanggal,
        (
            (SELECT COALESCE(SUM(d.invd_jumlah * (d.invd_harga - d.invd_diskon)), 0) 
             FROM tinv_dtl d WHERE d.invd_inv_nomor IN (
                SELECT inv_nomor FROM tinv_hdr h2 
                WHERE DATE(h2.inv_tanggal) = DATE(h.inv_tanggal) 
                ${branchCondition.replace(
                  "h.",
                  "h2."
                )} -- FIX: Use alias h2 for subquery if needed, or rely on main WHERE
             ))
             -
             SUM(h.inv_disc)
        ) as total
      FROM tinv_hdr h
      WHERE h.inv_tanggal BETWEEN ? AND ?
        AND h.inv_sts_pro = 0
        ${branchCondition} -- Apply filter to main query
      GROUP BY ${dateSelect}
      ORDER BY tanggal ASC
    `;

    // NOTE: The subquery above is complex and might ignore the branch condition
    // if not careful. Let's SIMPLIFY the query to ensure safety.

    // BETTER SIMPLE QUERY (Recommended):
    const simpleQuery = `
        SELECT 
            ${dateSelect} as tanggal,
            SUM( (d.invd_jumlah * (d.invd_harga - d.invd_diskon)) ) - SUM(DISTINCT h.inv_disc) as total
        FROM tinv_hdr h
        JOIN tinv_dtl d ON h.inv_nomor = d.invd_inv_nomor
        WHERE h.inv_tanggal BETWEEN ? AND ?
          AND h.inv_sts_pro = 0
          ${branchCondition}
        GROUP BY ${dateSelect}
        ORDER BY tanggal ASC
    `;

    const [rows] = await pool.query(simpleQuery, params);
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

// --- 14. Laporan Stok Minus (Dashboard Warning) ---
const getNegativeStockReport = async (req, res) => {
  try {
    const user = req.user;
    const { cabang } = req.query;

    // Params awal kosong (karena kita hapus filter tanggal)
    const params = [];
    let cabangFilter = "";

    // LOGIKA FILTER CABANG (Diperbaiki)
    if (user.cabang !== "KDC") {
      // 1. User Cabang: Kunci ke cabangnya sendiri
      cabangFilter = "AND mst_cab = ?";
      params.push(user.cabang);
    } else {
      // 2. User KDC
      if (cabang && cabang !== "KDC" && cabang !== "ALL") {
        // Pilih cabang spesifik
        cabangFilter = "AND mst_cab = ?";
        params.push(cabang);
      }
      // Jika 'ALL', biarkan cabangFilter kosong agar mengambil SEMUA gudang (Toko + DC)
    }

    const query = `
      SELECT
          s.mst_brg_kode AS kode,
          b.brgd_barcode AS barcode,
          a.brg_ktgp AS kategori,
          TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama,
          s.mst_ukuran AS ukuran,
          s.stok,
          s.mst_cab AS cabang_kode,
          IFNULL(g.gdg_nama, s.mst_cab) AS cabang_nama
      FROM (
          SELECT 
              mst_brg_kode, 
              mst_ukuran, 
              mst_cab,
              SUM(mst_stok_in - mst_stok_out) AS stok
          FROM tmasterstok
          WHERE mst_aktif = 'Y'
            -- HAPUS filter tanggal agar menghitung total stok real-time sampai detik ini
            ${cabangFilter}
          GROUP BY mst_brg_kode, mst_ukuran, mst_cab
          HAVING stok < 0
      ) s
      LEFT JOIN tbarangdc a ON a.brg_kode = s.mst_brg_kode
      LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = s.mst_brg_kode AND b.brgd_ukuran = s.mst_ukuran
      LEFT JOIN tgudang g ON g.gdg_kode = s.mst_cab
      WHERE a.brg_logstok = 'Y' 
      ORDER BY s.stok ASC
      LIMIT 20;
    `;

    // Debugging (Cek di terminal backend jika masih kosong)
    // console.log('Query Stok Minus:', query);
    // console.log('Params:', params);

    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getNegativeStockReport:", error);
    res.status(500).json({ message: "Gagal memuat stok minus" });
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
  getNegativeStockReport,
};
