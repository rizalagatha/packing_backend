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

/**
 * Mencari data dari tabel tampungan selisih yang statusnya masih OPEN.
 */
const searchPendingRetur = async (req, res) => {
  try {
    const user = req.user;
    const query = `
            SELECT 
                pending_nomor AS nomor, 
                sj_nomor,
                tanggal_pending AS tanggal
            FROM tpendingsj 
            WHERE 
                kode_store = ? 
                AND status = 'OPEN'
            ORDER BY tanggal_pending DESC;
        `;
    const [rows] = await pool.query(query, [user.cabang]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in searchPendingRetur:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari data pending retur." });
  }
};

/**
 * Memuat item yang selisih dari sebuah nomor pending.
 */
const loadSelisihData = async (req, res) => {
  try {
    const { pendingNomor } = req.params;
    const [rows] = await pool.query(
      "SELECT items_json, sj_nomor FROM tpendingsj WHERE pending_nomor = ?",
      [pendingNomor]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data pending tidak ditemukan." });
    }

    const allItems = JSON.parse(rows[0].items_json);
    const selisihItems = allItems
      .filter((item) => item.jumlahKirim - item.jumlahTerima > 0)
      .map((item) => ({
        ...item,
        selisih: item.jumlahKirim - item.jumlahTerima,
      }));

    // Ambil data header SJ asli untuk kelengkapan info
    const [sjHeaderRows] = await pool.query(
      "SELECT * FROM tdc_sj_hdr WHERE sj_nomor = ?",
      [rows[0].sj_nomor]
    );

    res.status(200).json({
      success: true,
      data: {
        headerSj: sjHeaderRows[0],
        items: selisihItems,
      },
    });
  } catch (error) {
    console.error("Error in loadSelisihData (Retur):", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat data selisih." });
  }
};

/**
 * Menyimpan data retur dan menutup status pending.
 */
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
      // Simpan jumlah selisih ke kolom rbd_jumlah
      return [idrec, iddrec, rbNomor, item.kode, item.ukuran, item.selisih, 0];
    });

    if (detailValues.length > 0) {
      await connection.query(
        `INSERT INTO trbdc_dtl (rbd_idrec, rbd_iddrec, rbd_nomor, rbd_kode, rbd_ukuran, rbd_jumlah, rbd_input) VALUES ?;`,
        [detailValues]
      );
    }

    // --- UPDATE STATUS PENDING MENJADI CLOSE ---
    await connection.query(
      `UPDATE tpendingsj SET status = 'CLOSE' WHERE pending_nomor = ?`,
      [header.nomorPenerimaan]
    );

    await connection.commit();
    res
      .status(201)
      .json({
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
  searchPendingRetur,
  loadSelisihData,
  saveRetur,
};
