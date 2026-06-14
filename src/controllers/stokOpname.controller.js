const pool = require("../config/database");
const moment = require("moment");

// --- FUNGSI BARU: List Cabang (Untuk Dropdown Stok Opname) ---
const getCabangList = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT 
        gdg_kode AS kode,
        gdg_nama AS nama
      FROM tgudang
      WHERE gdg_dc IN (0, 1)
      ORDER BY gdg_kode
      `,
    );

    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// 1. Download Master (Revisi: Terima parameter cabang)
const downloadMasterBarang = async (req, res) => {
  try {
    const query = `
      SELECT 
        -- Jika barcode di detail kosong, gunakan kode barang sebagai barcode
        TRIM(IFNULL(d.brgd_barcode, h.brg_kode)) AS barcode,
        h.brg_kode AS kode,
        TRIM(CONCAT(IFNULL(h.brg_jeniskaos,''), " ", IFNULL(h.brg_tipe,''), " ", IFNULL(h.brg_lengan,''), " ", IFNULL(h.brg_jeniskain,''), " ", IFNULL(h.brg_warna,''))) AS nama,
        IFNULL(d.brgd_ukuran, '') AS ukuran,
        '' AS lokasi,
        0 AS stok_sistem
      FROM tbarangdc h
      -- Gunakan LEFT JOIN agar barang tetap muncul meski tidak ada di detail barcode
      LEFT JOIN tbarangdc_dtl d ON h.brg_kode = d.brgd_kode
      -- Pastikan TIDAK ADA filter WHERE brg_aktif = '1' di sini
      ORDER BY barcode ASC;
    `;

    const [rows] = await pool.query(query);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error downloadMasterBarang:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mendownload data barang." });
  }
};

const downloadMasterLokasi = async (req, res) => {
  try {
    const { cabang } = req.query; // Ambil parameter cabang dari query string

    if (!cabang) {
      return res.status(400).json({
        success: false,
        message: "Parameter cabang harus diisi.",
      });
    }

    const query = `
      SELECT 
        lo_idrec, 
        lo_cab, 
        lo_lokasi, 
        lo_jenis_nama 
      FROM tlokasi_opname 
      WHERE lo_cab = ?
      ORDER BY lo_lokasi ASC
    `;

    const [rows] = await pool.query(query, [cabang]);

    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error downloadMasterLokasi:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mendownload data master lokasi.",
    });
  }
};

// --- 2. Upload Hasil (Integrasi ke tabel thitungstok dengan Filter Tanggal SO) ---
const uploadHasilOpname = async (req, res) => {
  const { items, targetCabang, deviceInfo, operatorName } = req.body;

  const totalPcs = items.reduce((sum, i) => sum + Number(i.qty_fisik || 0), 0);
  const user = req.user;
  const cabangTujuan = targetCabang || user.cabang;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. CARI TANGGAL STOK OPNAME AKTIF (st_transfer = 'N')
    const [activeSoRows] = await connection.query(
      `SELECT st_tanggal FROM tsop_tanggal WHERE st_cab = ? AND st_transfer = 'N' ORDER BY st_tanggal DESC LIMIT 1`,
      [cabangTujuan],
    );

    // Jika tidak ada jadwal SO aktif, jadikan hari ini sebagai default fallback
    const activeSoDate =
      activeSoRows.length > 0
        ? moment(activeSoRows[0].st_tanggal).format("YYYY-MM-DD")
        : moment().format("YYYY-MM-DD");

    // 2. LOGIKA AKUMULASI CERDAS (Mencegah penambahan ke data SO lama)
    const query = `
      INSERT INTO thitungstok 
        (hs_cab, hs_lokasi, hs_barcode, hs_kode, hs_nama, hs_ukuran, hs_qty, hs_proses, hs_device, hs_operator, date_create, user_create, hs_nopl, hs_noprod)
      VALUES ?
      ON DUPLICATE KEY UPDATE 
        -- JIKA data sudah diproses ('Y') ATAU tanggal scan-nya lebih tua dari jadwal SO aktif, maka TIMPA (RESET) data lamanya.
        -- JIKA masih di periode SO yang sama ('N'), maka AKUMULASIKAN (+).
        hs_qty = IF(hs_proses = 'Y' OR date_create IS NULL OR DATE(date_create) < ?, VALUES(hs_qty), hs_qty + VALUES(hs_qty)),
        hs_proses = 'N', -- Selalu buka statusnya karena ada scan baru di periode aktif
        hs_device = VALUES(hs_device),
        hs_operator = VALUES(hs_operator),
        user_create = VALUES(user_create),
        date_create = VALUES(date_create),
        hs_nopl = IF(VALUES(hs_nopl) != '', VALUES(hs_nopl), hs_nopl),    
        hs_noprod = IF(VALUES(hs_noprod) != '', VALUES(hs_noprod), hs_noprod)
    `;

    const values = items.map((item) => [
      cabangTujuan,
      item.lokasi || "",
      item.barcode,
      item.kode,
      item.nama,
      item.ukuran,
      item.qty_fisik,
      "N",
      deviceInfo || "Unknown",
      operatorName || "No Name",
      new Date(),
      user.kode,
      item.no_pl || "",
      item.no_pack || "",
    ]);

    if (values.length > 0) {
      // Perhatikan urutan parameter: [ array values, parameter activeSoDate untuk IF statement ]
      await connection.query(query, [values, activeSoDate]);
    }

    await connection.commit();
    res.status(200).json({
      success: true,
      message: `Berhasil upload parsial. Data diproses sesuai jadwal SO aktif (${activeSoDate}).`,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// --- FUNGSI KOMPARASI STOK OPNAME (Juga harus memfilter data lama) ---
const checkMismatchLokasi = async (req, res) => {
  try {
    const { cabang, lokasi } = req.query;

    if (!cabang || !lokasi) {
      return res
        .status(400)
        .json({ success: false, message: "Cabang dan Lokasi wajib diisi" });
    }

    // Ambil rekap data dari thitungstok di server
    // TAMBAHAN: Kita tambahkan AND hs_proses = 'N' agar fitur komparasi di HP tidak ikut mengkalkulasi bangkai data lama.
    const query = `
      SELECT 
        hs_barcode AS barcode, 
        hs_nama AS nama, 
        SUM(hs_qty) AS qty_server
      FROM thitungstok
      WHERE hs_cab = ? AND hs_lokasi = ? AND hs_proses = 'N'
      GROUP BY hs_barcode, hs_nama
    `;

    const [rows] = await pool.query(query, [cabang, lokasi]);

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Error checkMismatchLokasi:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getCabangList,
  downloadMasterBarang,
  downloadMasterLokasi,
  uploadHasilOpname,
  checkMismatchLokasi,
};
