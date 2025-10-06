const pool = require("../config/database");
const { format } = require("date-fns");

const generateNewRbNumber = async (gudang, tanggal) => {
  const date = new Date(tanggal);
  const prefix = `${gudang}.RB.${format(date, "yyMM")}.`;
  const query = `SELECT IFNULL(MAX(RIGHT(rb_nomor, 4)), 0) + 1 AS next_num FROM trbdc_hdr WHERE rb_nomor LIKE ?;`;
  const [rows] = await pool.query(query, [`${prefix}%`]);
  return `${prefix}${rows[0].next_num.toString().padStart(4, "0")}`;
};

const searchPendingRetur = async (req, res) => {
  try {
    const user = req.user;
    // Ambil 'status' dari query, default-nya adalah 'OPEN'
    const { status = "OPEN" } = req.query;

    const query = `
            SELECT 
                pending_nomor AS nomor, 
                sj_nomor, 
                tj_nomor, 
                tanggal_pending AS tanggal,
                status
            FROM tpendingsj 
            WHERE 
                kode_store = ? 
                AND status = ? -- -> Gunakan parameter status di sini
            ORDER BY tanggal_pending DESC;
        `;

    const [rows] = await pool.query(query, [user.cabang, status]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in searchPendingRetur:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari data pending retur." });
  }
};

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

    const sjHeaderQuery = `
        SELECT 
            h.*, 
            LEFT(h.sj_nomor, 3) AS gudang_asal_kode,
            g.gdg_nama AS gudang_asal_nama 
        FROM tdc_sj_hdr h
        LEFT JOIN tgudang g ON LEFT(h.sj_nomor, 3) = g.gdg_kode
        WHERE h.sj_nomor = ?
    `;
    const [sjHeaderRows] = await pool.query(sjHeaderQuery, [rows[0].sj_nomor]);

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

    // --- PERBAIKAN LOGIKA DI SINI ---
    // `rb_noterima` diisi dengan `nomorPending` dari frontend.
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

    // await connection.query(
    //   `UPDATE tpendingsj SET status = 'CLOSE' WHERE pending_nomor = ?`, // -> Menggunakan tabel tpendingsj
    //   [header.nomorPending]
    // );

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
  searchPendingRetur,
  loadSelisihData,
  saveRetur,
};
