const pool = require("../config/database");
const { format } = require("date-fns");
const whatsappService = require("../services/whatsapp.service");

// --- Helper Function ---
const generateNewTjNumber = async (gudang, tanggal) => {
  const date = new Date(tanggal);
  const prefix = `${gudang}.TJ.${format(date, "yyMM")}.`;
  const query = `SELECT IFNULL(MAX(RIGHT(tj_nomor, 4)), 0) + 1 AS next_num FROM ttrm_sj_hdr WHERE tj_nomor LIKE ?;`;
  const [rows] = await pool.query(query, [`${prefix}%`]);
  const nextNumber = rows[0].next_num.toString().padStart(4, "0");
  return `${prefix}${nextNumber}`;
};

const generateNewPendingNumber = async (storeCode, tanggal) => {
  const date = new Date(tanggal);
  const prefix = `${storeCode}.PD.${format(date, "yyMM")}.`;
  const query = `SELECT IFNULL(MAX(RIGHT(pending_nomor, 4)), 0) + 1 AS next_num FROM tpendingsj WHERE pending_nomor LIKE ?;`;
  const [rows] = await pool.query(query, [`${prefix}%`]);
  return `${prefix}${rows[0].next_num.toString().padStart(4, "0")}`;
};

// --- Controller Functions ---

const searchSj = async (req, res) => {
  try {
    const { term } = req.query;
    const user = req.user; // Info user store yang login
    const searchTerm = `%${term || ""}%`;

    // Query untuk mencari SJ yang ditujukan ke cabang/store user, dan belum pernah diterima
    const query = `
            SELECT sj_nomor AS nomor, sj_tanggal AS tanggal 
            FROM tdc_sj_hdr 
            WHERE sj_kecab = ? AND (sj_noterima IS NULL OR sj_noterima = '') AND sj_nomor LIKE ?
            ORDER BY sj_tanggal DESC;
        `;
    const [rows] = await pool.query(query, [user.cabang, searchTerm]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in searchSj:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari Surat Jalan." });
  }
};

const loadInitialData = async (req, res) => {
  try {
    const { nomorSj } = req.params;
    const headerQuery = `SELECT h.sj_nomor, h.sj_tanggal, h.sj_mt_nomor, h.sj_ket AS keterangan, LEFT(h.sj_nomor, 3) AS gudang_asal_kode, g_asal.gdg_nama AS gudang_asal_nama FROM tdc_sj_hdr h LEFT JOIN tgudang g_asal ON g_asal.gdg_kode = LEFT(h.sj_nomor, 3) WHERE h.sj_nomor = ?;`;
    const [headerRows] = await pool.query(headerQuery, [nomorSj]);
    if (headerRows.length === 0)
      throw new Error("Data Surat Jalan tidak ditemukan.");

    const itemsQuery = `SELECT d.sjd_kode AS kode, b.brgd_barcode AS barcode, TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama, d.sjd_ukuran AS ukuran, d.sjd_jumlah AS jumlahKirim FROM tdc_sj_dtl d LEFT JOIN tbarangdc a ON a.brg_kode = d.sjd_kode LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.sjd_kode AND b.brgd_ukuran = d.sjd_ukuran WHERE d.sjd_nomor = ? ORDER BY d.sjd_kode, d.sjd_ukuran;`;
    const [items] = await pool.query(itemsQuery, [nomorSj]);

    res
      .status(200)
      .json({ success: true, data: { header: headerRows[0], items } });
  } catch (error) {
    console.error("Error in loadInitialData:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const saveData = async (req, res) => {
  const payload = req.body;
  const user = req.user;
  const { header, items } = payload;
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // --- Logika penyimpanan ke ttrm_sj_hdr dan ttrm_sj_dtl ---
    // (Kode ini sama persis seperti bagian atas di kode lama Anda)

    const tjNomor = await generateNewTjNumber(
      user.cabang,
      header.tanggalTerima
    );
    const timestamp = format(new Date(), "yyyyMMddHHmmssSSS");
    const idrec = `${user.cabang}TJ${timestamp}`;

    await connection.query(
      `INSERT INTO ttrm_sj_hdr (tj_idrec, tj_nomor, tj_tanggal, tj_mt_nomor, user_create, date_create) VALUES (?, ?, ?, ?, ?, NOW());`,
      [idrec, tjNomor, header.tanggalTerima, header.nomorMinta, user.kode]
    );

    const detailValues = items
      .filter((item) => item.jumlahTerima > 0)
      .map((item, index) => {
        const nourut = index + 1;
        const iddrec = `${idrec}${nourut}`;
        return [
          idrec,
          iddrec,
          tjNomor,
          item.kode,
          item.ukuran,
          item.jumlahTerima,
        ];
      });

    if (detailValues.length > 0) {
      await connection.query(
        `INSERT INTO ttrm_sj_dtl (tjd_idrec, tjd_iddrec, tjd_nomor, tjd_kode, tjd_ukuran, tjd_jumlah) VALUES ?;`,
        [detailValues]
      );
    }

    await connection.query(
      "UPDATE tdc_sj_hdr SET sj_noterima = ? WHERE sj_nomor = ?",
      [tjNomor, header.nomorSj]
    );

    if (header.nomorPending) {
      await connection.query(
        'UPDATE tpendingsj SET status = "CLOSE", tj_nomor = ? WHERE pending_nomor = ?',
        [tjNomor, header.nomorPending]
      );
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: `Penerimaan SJ berhasil disimpan dengan nomor ${tjNomor}.`,
      data: { nomor: tjNomor },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in saveData (Final):", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

const savePending = async (req, res) => {
  const { header, items, pending_nomor } = req.body; // Ambil pending_nomor
  const user = req.user;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    if (pending_nomor) {
      // --- LOGIKA UPDATE PENDING YANG SUDAH ADA ---
      await connection.query(
        `UPDATE tpendingsj SET items_json = ?, tanggal_pending = ? WHERE pending_nomor = ? AND kode_store = ?`,
        [
          JSON.stringify(items),
          header.tanggalTerima,
          pending_nomor,
          user.cabang,
        ]
      );

      await connection.commit();
      res.status(200).json({
        success: true,
        message: `Pending ${pending_nomor} berhasil diperbarui.`,
      });
    } else {
      // --- LOGIKA MEMBUAT PENDING BARU ---
      const newPendingNomor = await generateNewPendingNumber(
        user.cabang,
        header.tanggalTerima
      );

      const pendingData = {
        pending_nomor: newPendingNomor,
        sj_nomor: header.nomorSj,
        kode_store: user.cabang,
        user_create: user.kode,
        tanggal_pending: header.tanggalTerima,
        items_json: JSON.stringify(items), // Simpan seluruh item sebagai JSON string
      };

      await connection.query("INSERT INTO tpendingsj SET ?", pendingData);
      await connection.commit();

      // Kirim notifikasi WhatsApp hanya saat membuat pending baru
      const itemsWithSelisih = items.filter(
        (item) => item.jumlahKirim - item.jumlahTerima > 0
      );
      if (itemsWithSelisih.length > 0) {
        let waMessage = `*Notifikasi Penerimaan Pending*\n\nNomor Pending: *${newPendingNomor}*\nNo. SJ: *${header.nomorSj}*\nStore: *${user.cabang}*\n\nTerdapat selisih barang yang perlu diproses:\n`;
        itemsWithSelisih.forEach((item) => {
          waMessage += `- ${item.nama} (${item.ukuran}): Selisih *${
            item.jumlahKirim - item.jumlahTerima
          }* pcs\n`;
        });
        await whatsappService.sendMessageToStore(user.cabang, waMessage);
      }

      res.status(201).json({
        success: true,
        message: `Penerimaan berhasil disimpan sebagai PENDING dengan nomor ${newPendingNomor}.`,
      });
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in savePending:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal menyimpan data pending." });
  } finally {
    if (connection) connection.release();
  }
};

const searchPendingSj = async (req, res) => {
  try {
    const user = req.user;
    const query = `
            SELECT pending_nomor AS nomor, sj_nomor, tanggal_pending AS tanggal 
            FROM tpendingsj 
            WHERE kode_store = ? AND status = 'OPEN';
        `;
    const [rows] = await pool.query(query, [user.cabang]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in searchPendingSj:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari data pending." });
  }
};

const loadPendingSj = async (req, res) => {
  try {
    const { pendingNomor } = req.params;
    const [rows] = await pool.query(
      "SELECT * FROM tpendingsj WHERE pending_nomor = ?",
      [pendingNomor]
    );
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data pending tidak ditemukan." });
    }

    const pendingData = rows[0];
    // Muat juga data header SJ asli untuk kelengkapan info
    const [sjHeaderRows] = await pool.query(
      `SELECT h.sj_nomor, h.sj_tanggal, h.sj_mt_nomor, h.sj_ket AS keterangan, LEFT(h.sj_nomor, 3) AS gudang_asal_kode, g_asal.gdg_nama AS gudang_asal_nama FROM tdc_sj_hdr h LEFT JOIN tgudang g_asal ON g_asal.gdg_kode = LEFT(h.sj_nomor, 3) WHERE h.sj_nomor = ?;`,
      [pendingData.sj_nomor]
    );

    res.status(200).json({
      success: true,
      data: {
        header: sjHeaderRows[0],
        items: JSON.parse(pendingData.items_json), // Kembalikan item dari JSON
        pendingNomor: pendingData.pending_nomor,
      },
    });
  } catch (error) {
    console.error("Error in loadPendingSj:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat data pending." });
  }
};

module.exports = {
  searchSj,
  loadInitialData,
  saveData,
  savePending,
  searchPendingSj,
  loadPendingSj,
};
