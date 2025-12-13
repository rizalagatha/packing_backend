const pool = require("../config/database");

// --- Helper: Format Tanggal ---
// (Opsional, jika dibutuhkan logika filter tanggal)

// 1. Get Cabang List (Untuk Filter)
const getCabangList = async (req, res) => {
  try {
    const user = req.user;
    let query = "";
    const params = [];

    if (user.cabang === "KDC") {
      query =
        "SELECT gdg_kode AS kode, gdg_nama AS nama FROM tgudang ORDER BY gdg_kode";
    } else {
      query =
        "SELECT gdg_kode AS kode, gdg_nama AS nama FROM tgudang WHERE gdg_kode = ? ORDER BY gdg_kode";
      params.push(user.cabang);
    }

    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getCabangList:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// 2. Get Invoice List (Browse) - DENGAN PAGINATION
const getList = async (req, res) => {
  try {
    // Ambil filter dari query params
    // NEW: Tambahkan page & limit
    const {
      startDate,
      endDate,
      cabang,
      status,
      page = 1,
      limit = 20,
      search,
    } = req.query;

    const params = [startDate, endDate];
    let cabangFilter = "";

    // Filter Cabang
    if (cabang && cabang !== "KDC") {
      cabangFilter = " AND h.inv_cab = ?";
      params.push(cabang);
    }

    // Filter Status (Sisa Piutang / Belum Lunas)
    let statusFilterClause = "";
    if (status === "sisa_piutang" || status === "belum_lunas") {
      statusFilterClause = `
                AND EXISTS (
                    SELECT 1 
                    FROM tpiutang_hdr u
                    LEFT JOIN (
                        SELECT pd_ph_nomor, SUM(pd_debet) AS debet, SUM(pd_kredit) AS kredit 
                        FROM tpiutang_dtl GROUP BY pd_ph_nomor
                    ) v ON v.pd_ph_nomor = u.ph_nomor
                    WHERE u.ph_inv_nomor = FL.Nomor
                      AND (IFNULL(v.debet, 0) - IFNULL(v.kredit, 0)) > 100
                )
            `;
    }

    // --- NEW: Filter Search (Server Side) ---
    // Agar pagination tetap akurat saat mencari data
    let searchFilterClause = "";
    if (search) {
      searchFilterClause = ` AND (FL.Nomor LIKE ? OR FL.Nama LIKE ?) `;
      params.push(`%${search}%`, `%${search}%`);
    }

    // --- NEW: Pagination Logic ---
    const limitVal = parseInt(limit) || 20;
    const pageVal = parseInt(page) || 1;
    const offsetVal = (pageVal - 1) * limitVal;

    const query = `
            WITH
            Promo AS (
                SELECT pro_nomor, pro_lipat FROM tpromo
            ),
            DetailCalc AS (
                SELECT 
                  d.invd_inv_nomor, d.invd_jumlah, d.invd_harga, d.invd_diskon,
                  h.inv_pro_nomor,
                  (SELECT pro_lipat FROM Promo p WHERE p.pro_nomor = h.inv_pro_nomor LIMIT 1) AS lipat
                FROM tinv_dtl d
                LEFT JOIN tinv_hdr h ON h.inv_nomor = d.invd_inv_nomor
            ),
            SumNominal AS (
                SELECT
                  dc.invd_inv_nomor,
                  ROUND(SUM(dc.invd_jumlah * (dc.invd_harga - dc.invd_diskon)) - COALESCE(h.inv_disc, 0), 0) AS NominalPiutang
                FROM DetailCalc dc
                LEFT JOIN tinv_hdr h ON h.inv_nomor = dc.invd_inv_nomor
                GROUP BY dc.invd_inv_nomor
            ),
            DPUsed AS (
                SELECT sd.sd_inv AS inv_nomor, SUM(sd.sd_bayar) AS dpDipakai
                FROM tsetor_dtl sd
                WHERE sd.sd_ket = 'DP LINK DARI INV'
                GROUP BY sd.sd_inv
            ),
            FinalList AS (
                SELECT 
                    h.inv_nomor AS Nomor,
                    h.inv_tanggal AS Tanggal,
                    h.inv_cus_kode AS Kdcus,
                    c.cus_nama AS Nama,
                    
                    -- Hitung Nominal (Total Belanja)
                    (
                      COALESCE(SN.NominalPiutang,0) 
                      + h.inv_ppn 
                      + h.inv_bkrm 
                      - COALESCE(h.inv_mp_biaya_platform, 0)
                    ) AS Nominal,

                    -- Hitung Sisa Piutang (Simplified logic for List Display)
                    GREATEST(
                      (COALESCE(SN.NominalPiutang,0) + h.inv_ppn + h.inv_bkrm) 
                      - 
                      (h.inv_bayar + IFNULL(h.inv_pundiamal,0) - h.inv_kembali), 
                      0
                    ) AS SisaPiutang

                FROM tinv_hdr h
                LEFT JOIN tcustomer c ON c.cus_kode = h.inv_cus_kode
                LEFT JOIN SumNominal SN ON SN.invd_inv_nomor = h.inv_nomor
                WHERE h.inv_sts_pro = 0
                  AND h.inv_tanggal BETWEEN ? AND ? 
                  ${cabangFilter}
            )
            SELECT * FROM FinalList FL
            WHERE 1=1
            ${statusFilterClause}
            ${searchFilterClause}
            ORDER BY FL.Tanggal DESC, FL.Nomor DESC
            LIMIT ? OFFSET ?;  -- NEW: Pagination
        `;

    // Tambahkan params limit & offset di akhir array params
    params.push(limitVal, offsetVal);

    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getList:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// 3. Get Invoice Details (Untuk Modal View)
const getDetails = async (req, res) => {
  try {
    const { nomor } = req.params;

    const query = `
            SELECT 
              d.invd_kode AS Kode,
              IFNULL(b.brgd_barcode, "") AS Barcode,
              IF(
                d.invd_pro_nomor = "",
                IFNULL(TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)), f.sd_nama),
                TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna, " #BONUS"))
              ) AS Nama,
              d.invd_ukuran AS Ukuran,
              d.invd_jumlah AS Jumlah,
              d.invd_harga AS Harga,
              
              -- Diskon Aktif per Pcs
              CASE
                WHEN (SELECT p.pro_lipat FROM tpromo p WHERE p.pro_nomor = h.inv_pro_nomor LIMIT 1) = 'N'
                     AND (SELECT COUNT(*) FROM tinv_dtl x WHERE x.invd_inv_nomor = h.inv_nomor AND x.invd_diskon > 0 AND x.invd_nourut < d.invd_nourut) > 0
                THEN 0
                ELSE d.invd_diskon
              END AS DiskonAktif,

              -- Total Line
              CASE
                WHEN (SELECT p.pro_lipat FROM tpromo p WHERE p.pro_nomor = h.inv_pro_nomor LIMIT 1) = 'N'
                     AND (SELECT COUNT(*) FROM tinv_dtl x WHERE x.invd_inv_nomor = h.inv_nomor AND x.invd_diskon > 0 AND x.invd_nourut < d.invd_nourut) > 0
                THEN (d.invd_jumlah * d.invd_harga)
                ELSE (d.invd_jumlah * (d.invd_harga - d.invd_diskon))
              END AS Total

            FROM tinv_dtl d
            LEFT JOIN tinv_hdr h ON h.inv_nomor = d.invd_inv_nomor
            LEFT JOIN tbarangdc a ON a.brg_kode = d.invd_kode
            LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.invd_kode AND b.brgd_ukuran = d.invd_ukuran
            LEFT JOIN tsodtf_hdr f ON f.sd_nomor = d.invd_kode
            WHERE d.invd_inv_nomor = ?
            ORDER BY d.invd_nourut;
        `;

    const [rows] = await pool.query(query, [nomor]);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getDetails:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getCabangList,
  getList,
  getDetails,
};
