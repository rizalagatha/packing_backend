const pool = require("../config/database");
const { format } = require("date-fns");

// --- Helper Functions ---
const generateNewRbNumber = async (gudang, tanggal) => {
  const date = new Date(tanggal);
  const prefix = `${gudang}.RB.${format(date, "yyMM")}.`;
  const query = `SELECT IFNULL(MAX(RIGHT(rb_nomor, 4)), 0) + 1 AS next_num FROM trbdc_hdr WHERE rb_nomor LIKE ?;`;
  const [rows] = await pool.query(query, [`${prefix}%`]);
  return `${prefix}${rows[0].next_num.toString().padStart(4, "0")}`;
};

// --- Controller Functions ---

const searchPenerimaanSj = async (req, res) => {
  try {
    const user = req.user;
    const query = `
            SELECT 
                h.tj_nomor AS nomor, 
                h.tj_tanggal AS tanggal,
                (SELECT sj_nomor FROM tdc_sj_hdr WHERE sj_noterima = h.tj_nomor LIMIT 1) as no_sj
            FROM ttrm_sj_hdr h
            LEFT JOIN trbdc_hdr r ON h.tj_nomor = r.rb_noterima
            WHERE 
                LEFT(h.tj_nomor, 3) = ? 
                AND r.rb_nomor IS NULL
                AND (
                    (SELECT SUM(sjd.sjd_jumlah) FROM tdc_sj_dtl sjd WHERE sjd.sjd_nomor = (
                        SELECT sjh.sj_nomor FROM tdc_sj_hdr sjh WHERE sjh.sj_noterima = h.tj_nomor LIMIT 1
                    )) > 
                    (SELECT SUM(tjd.tjd_jumlah) FROM ttrm_sj_dtl tjd WHERE tjd.tjd_nomor = h.tj_nomor)
                )
            ORDER BY h.tj_tanggal DESC;
        `;
    const [rows] = await pool.query(query, [user.cabang]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in searchPenerimaanSj:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari data penerimaan." });
  }
};

const loadSelisihData = async (req, res) => {
  try {
    const { tjNomor } = req.params;
    const noSjQuery = `SELECT sj_nomor FROM tdc_sj_hdr WHERE sj_noterima = ?`;
    const [sjRows] = await pool.query(noSjQuery, [tjNomor]);
    if (sjRows.length === 0)
      throw new Error("Surat Jalan terkait tidak ditemukan.");
    const nomorSj = sjRows[0].sj_nomor;

    const query = `
            SELECT 
                kirim.sjd_kode AS kode,
                brg_dtl.brgd_barcode AS barcode,
                TRIM(CONCAT(brg.brg_jeniskaos, " ", brg.brg_tipe, " ", brg.brg_lengan, " ", brg.brg_jeniskain, " ", brg.brg_warna)) AS nama,
                kirim.sjd_ukuran AS ukuran,
                kirim.sjd_jumlah AS jumlahKirim,
                IFNULL(terima.tjd_jumlah, 0) AS jumlahTerima,
                (kirim.sjd_jumlah - IFNULL(terima.tjd_jumlah, 0)) AS selisih
            FROM tdc_sj_dtl kirim
            LEFT JOIN ttrm_sj_dtl terima ON kirim.sjd_nomor = (SELECT sj_nomor FROM tdc_sj_hdr WHERE sj_noterima = terima.tjd_nomor) AND kirim.sjd_kode = terima.tjd_kode AND kirim.sjd_ukuran = terima.tjd_ukuran
            LEFT JOIN tbarangdc brg ON kirim.sjd_kode = brg.brg_kode
            LEFT JOIN tbarangdc_dtl brg_dtl ON kirim.sjd_kode = brg_dtl.brgd_kode AND kirim.sjd_ukuran = brg_dtl.brgd_ukuran
            WHERE kirim.sjd_nomor = ? AND (kirim.sjd_jumlah - IFNULL(terima.tjd_jumlah, 0)) > 0;
        `;
    const [items] = await pool.query(query, [nomorSj]);
    res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("Error in loadSelisihData:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat data selisih." });
  }
};

const saveRetur = async (req, res) => {
  const { header, items } = req.body;
  const user = req.user;
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const rbNomor = await generateNewRbNumber(user.cabang, header.tanggalRetur);
    const timestamp = format(new Date(), "yyyyMMddHHmmssSSS");
    const idrec = `${user.cabang}RB${timestamp}`;

    await connection.query(
      `INSERT INTO trbdc_hdr (rb_idrec, rb_nomor, rb_tanggal, rb_kecab, rb_noterima, rb_ket, user_create, date_create) VALUES (?, ?, ?, ?, ?, ?, ?, NOW());`,
      [
        idrec,
        rbNomor,
        header.tanggalRetur,
        header.gudangTujuan,
        header.nomorPenerimaan,
        header.keterangan,
        user.kode,
      ]
    );

    const detailValues = items.map((item, index) => {
      const nourut = index + 1;
      const iddrec = `${idrec}${nourut}`;
      return [idrec, iddrec, rbNomor, item.kode, item.ukuran, item.selisih, 0];
    });

    if (detailValues.length > 0) {
      await connection.query(
        `INSERT INTO trbdc_dtl (rbd_idrec, rbd_iddrec, rbd_nomor, rbd_kode, rbd_ukuran, rbd_jumlah, rbd_input) VALUES ?;`,
        [detailValues]
      );
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: `Retur berhasil disimpan dengan nomor ${rbNomor}.`,
      data: { nomor: rbNomor },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in saveRetur:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  searchPenerimaanSj,
  loadSelisihData,
  saveRetur,
};
