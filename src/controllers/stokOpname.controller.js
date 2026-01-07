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

// 2. Upload Hasil (Integrasi ke tabel thitungstok)
const uploadHasilOpname = async (req, res) => {
  const { items, targetCabang } = req.body;
  const user = req.user;

  // Gunakan cabang tujuan yang dipilih user (atau fallback ke cabang user)
  const cabangTujuan = targetCabang || user.cabang;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    /**
     * Menggunakan ON DUPLICATE KEY UPDATE.
     * Jika (hs_cab, hs_lokasi, hs_barcode) sudah ada, maka qty akan ditambah.
     * date_create menggunakan CURDATE() sesuai standar tabel thitungstok.
     */
    const query = `
      INSERT INTO thitungstok 
        (hs_cab, hs_lokasi, hs_barcode, hs_kode, hs_nama, hs_ukuran, hs_qty, hs_proses, date_create, user_create)
      VALUES ?
      ON DUPLICATE KEY UPDATE 
        hs_qty = hs_qty + VALUES(hs_qty),
        hs_nama = VALUES(hs_nama)
    `;

    // Map data dari mobile ke kolom thitungstok
    const values = items.map((item) => [
      cabangTujuan,         // hs_cab
      item.lokasi || '',    // hs_lokasi
      item.barcode,         // hs_barcode
      item.kode,            // hs_kode
      item.nama,            // hs_nama
      item.ukuran,          // hs_ukuran
      item.qty_fisik,       // hs_qty
      'N',                  // hs_proses (Belum diproses)
      new Date(),           // date_create
      user.kode,            // user_create
    ]);

    if (values.length > 0) {
      await connection.query(query, [values]);
    }

    await connection.commit();
    res.status(200).json({
      success: true,
      message: `Berhasil upload ${items.length} item ke thitungstok cabang ${cabangTujuan}.`,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error uploadHasilOpname:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { getCabangList, downloadMasterBarang, uploadHasilOpname };
