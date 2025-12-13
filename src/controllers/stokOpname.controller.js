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
    const targetCabang = req.query.cabang || req.user.cabang;

    // REVISI: Hapus filter brg_aktif dan brg_logstok agar SAMA PERSIS dengan Delphi.
    // Kita hanya butuh Barcode, Kode, Nama, Ukuran.

    const query = `
            SELECT 
                TRIM(d.brgd_barcode) AS barcode,
                d.brgd_kode AS kode,
                TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
                d.brgd_ukuran AS ukuran,
                '' AS lokasi,
                0 AS stok_sistem -- Kita set 0 saja agar query lebih ringan, toh ini blind count
            FROM tbarangdc_dtl d
            JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
            -- HAPUS WHERE h.brg_aktif... AGAR SEMUA BARANG KEDOWNLOAD
            ORDER BY d.brgd_barcode ASC; 
        `;

    // Eksekusi tanpa parameter (karena kita hapus filter stok/cabang di query master)
    // Master barang biasanya berlaku global untuk semua cabang kan?
    const [rows] = await pool.query(query);

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error downloadMasterBarang:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mendownload data barang." });
  }
};

// 2. Upload Hasil (Revisi: Terima parameter cabang tujuan)
const uploadHasilOpname = async (req, res) => {
  const { items, targetCabang } = req.body; // <-- Terima targetCabang dari body
  const user = req.user;

  // Jika tidak dikirim, fallback ke cabang user sendiri
  const cabangTujuan = targetCabang || user.cabang;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const insertQuery = `
            INSERT INTO tstokopname_temp (so_cab, so_user, so_tanggal, so_barcode, so_kode, so_qty_fisik, so_qty_sistem, date_create)
            VALUES ?
        `;

    const values = items.map((item) => [
      cabangTujuan, // <-- Gunakan cabang tujuan yang dipilih
      user.kode,
      new Date(),
      item.barcode,
      item.kode,
      item.qty_fisik,
      item.stok_sistem,
      new Date(),
    ]);

    if (values.length > 0) {
      await connection.query(insertQuery, [values]);
    }

    await connection.commit();
    res.status(200).json({
      success: true,
      message: `Data opname untuk ${cabangTujuan} berhasil diupload.`,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error uploadHasilOpname:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mengupload data opname." });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { getCabangList, downloadMasterBarang, uploadHasilOpname };
