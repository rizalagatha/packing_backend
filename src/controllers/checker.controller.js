const pool = require("../config/database");

const searchStbj = async (req, res) => {
  try {
    const query = `
            SELECT stbj_nomor AS nomor, stbj_tanggal AS tanggal 
            FROM kencanaprint.tstbj_hdr 
            WHERE stbj_checker IS NULL OR stbj_checker <> 'Y'
            ORDER BY stbj_tanggal DESC;
        `;
    const [rows] = await pool.query(query);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari data STBJ." });
  }
};

const loadStbjData = async (req, res) => {
  try {
    const { stbjNomor } = req.params;

    const stbjQuery = `
            SELECT 
                d.stbjd_spk_nomor, 
                d.stbjd_size AS ukuran, 
                d.stbjd_jumlah AS jumlahKirim, 
                TRIM(CONCAT(brg.brg_jeniskaos, ' ', brg.brg_tipe, ' ', brg.brg_lengan, ' ', brg.brg_jeniskain, ' ', brg.brg_warna)) AS nama,
                dtl.brgd_barcode as barcode
            FROM kencanaprint.tstbj_dtl d
            LEFT JOIN tspk_dc spk ON d.stbjd_spk_nomor = spk.spkd_nomor
            LEFT JOIN tbarangdc brg ON spk.spkd_kode = brg.brg_kode
            LEFT JOIN tbarangdc_dtl dtl ON brg.brg_kode = dtl.brgd_kode AND d.stbjd_size = dtl.brgd_ukuran
            WHERE d.stbjd_stbj_nomor = ?;
        `;
    const [stbjItems] = await pool.query(stbjQuery, [stbjNomor]);

    if (stbjItems.length === 0) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Data detail untuk STBJ ini tidak ditemukan.",
        });
    }

    // Sekarang kita hanya mengembalikan data dari STBJ, tanpa data packing
    res.status(200).json({ success: true, data: stbjItems });
  } catch (error) {
    console.error("Error in loadStbjData:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat data STBJ." });
  }
};

const onCheck = async (req, res) => {
  const { stbj_nomor } = req.body;
  const user = req.user;
  try {
    await pool.query(
      "UPDATE kencanaprint.tstbj_hdr SET stbj_checker = 'Y', user_modified = ?, date_modified = NOW() WHERE stbj_nomor = ?",
      [user.kode, stbj_nomor]
    );
    res
      .status(200)
      .json({ success: true, message: `STBJ ${stbj_nomor} telah divalidasi.` });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Gagal mengupdate status STBJ." });
  }
};

module.exports = {
  searchStbj,
  loadStbjData,
  onCheck,
};
