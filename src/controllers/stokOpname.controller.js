const pool = require("../config/database");

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
      `
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
        TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
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

// 2. Upload Hasil (Integrasi ke tabel thitungstok)
const uploadHasilOpname = async (req, res) => {
  const { items, targetCabang, deviceInfo, operatorName } = req.body;

  // HITUNG TOTAL PCS UNTUK LOG
  const totalPcs = items.reduce((sum, i) => sum + Number(i.qty_fisik || 0), 0);

  console.log("========================================");
  console.log("DEBUG: Request Upload Opname Diterima!");
  console.log("Diterima dari Operator:", operatorName);
  console.log("Jumlah SKU (Baris):", items ? items.length : 0);
  console.log("Total Qty (Pcs):", totalPcs); // <--- Sekarang angka 40 akan muncul di sini
  console.log("========================================");
  const user = req.user;
  const cabangTujuan = targetCabang || user.cabang;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // --- LOGIKA AKUMULASI (CUMULATIVE) ---
    // hs_qty = hs_qty + VALUES(hs_qty) -> Menambahkan hasil scan baru ke data lama
    const query = `
      INSERT INTO thitungstok 
        (hs_cab, hs_lokasi, hs_barcode, hs_kode, hs_nama, hs_ukuran, hs_qty, hs_proses, hs_device, hs_operator, date_create, user_create)
      VALUES ?
      ON DUPLICATE KEY UPDATE 
        hs_qty = hs_qty + VALUES(hs_qty), 
        hs_device = VALUES(hs_device),
        hs_operator = VALUES(hs_operator),
        user_create = VALUES(user_create),
        date_create = VALUES(date_create)
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
    ]);

    if (values.length > 0) {
      await connection.query(query, [values]);
    }

    await connection.commit();
    res.status(200).json({
      success: true,
      message: `Berhasil upload parsial. Data telah dijumlahkan di server.`,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { getCabangList, downloadMasterBarang, uploadHasilOpname };
