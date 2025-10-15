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
      SELECT DISTINCT
        d.stbjd_spk_nomor, 
        d.stbjd_size AS ukuran, 
        d.stbjd_jumlah AS jumlahKirim,
        d.stbjd_packing, 
        TRIM(CONCAT(brg.brg_jeniskaos, ' ', brg.brg_tipe, ' ', brg.brg_lengan, ' ', brg.brg_jeniskain, ' ', brg.brg_warna)) AS nama,
        dtl.brgd_barcode as barcode
      FROM kencanaprint.tstbj_dtl d
      LEFT JOIN tspk_dc spk ON d.stbjd_spk_nomor = spk.spkd_nomor
      LEFT JOIN tbarangdc brg ON spk.spkd_kode = brg.brg_kode
      LEFT JOIN tbarangdc_dtl dtl ON brg.brg_kode = dtl.brgd_kode AND d.stbjd_size = dtl.brgd_ukuran
      WHERE d.stbjd_stbj_nomor = ?
      ORDER BY d.stbjd_packing, d.stbjd_spk_nomor, d.stbjd_size;
    `;

    console.log("Loading STBJ:", stbjNomor);

    const [stbjItems] = await pool.query(stbjQuery, [stbjNomor]);

    console.log("Total items loaded:", stbjItems.length);

    if (stbjItems.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data detail untuk STBJ ini tidak ditemukan.",
      });
    }

    // Add uniqueKey
    const itemsWithKey = stbjItems.map((item, index) => ({
      ...item,
      uniqueKey: `${item.stbjd_spk_nomor}-${item.ukuran}-${item.stbjd_packing}-${index}`,
    }));

    console.log("Sample item:", itemsWithKey[0]);

    res.status(200).json({ success: true, data: itemsWithKey });
  } catch (error) {
    console.error("Error in loadStbjData:", error);
    res.status(500).json({
      success: false,
      message: "Gagal memuat data STBJ.",
    });
  }
};

const getPackingDetailForChecker = async (req, res) => {
  try {
    const { nomor } = req.params;

    console.log("=== GET PACKING DETAIL ===");
    console.log("Requested nomor:", nomor);
    console.log("Type:", typeof nomor);
    console.log("Length:", nomor.length);

    // Try both with and without kencanaprint prefix
    let query = `
      SELECT 
        packd_barcode,
        packd_qty,
        packd_pack_nomor,
        size
      FROM tpacking_dtl
      WHERE packd_pack_nomor = ?
    `;

    let [rows] = await pool.query(query, [nomor]);

    console.log("Query without prefix - found:", rows.length);

    // If not found, try with prefix
    if (rows.length === 0) {
      query = `
        SELECT 
          packd_barcode,
          packd_qty,
          packd_pack_nomor,
          size
        FROM tpacking_dtl
        WHERE packd_pack_nomor = ?
      `;

      [rows] = await pool.query(query, [nomor]);
      console.log("Query with prefix - found:", rows.length);
    }

    if (rows.length === 0) {
      // Try to find similar
      const [similar] = await pool.query(
        "SELECT DISTINCT packd_pack_nomor FROM tpacking_dtl WHERE packd_pack_nomor LIKE ? LIMIT 5",
        [`%${nomor}%`]
      );
      console.log("Similar packing numbers:", similar);

      return res.status(404).json({
        success: false,
        message: "Nomor packing tidak ditemukan.",
        debug: {
          searched: nomor,
          similar: similar.map((s) => s.packd_pack_nomor),
        },
      });
    }

    console.log("Sample row:", rows[0]);

    res.status(200).json({
      success: true,
      data: { items: rows },
    });
  } catch (error) {
    console.error("Error in getPackingDetailForChecker:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
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
  getPackingDetailForChecker,
};
