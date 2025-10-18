const pool = require("../config/database");

// --- Helper Function ---
const generateNewNomor = async (cabang, tanggal) => {
  const year = new Date(tanggal).getFullYear().toString().substring(2);
  const prefix = `${cabang}.MSK.${year}`;
  const query = `SELECT IFNULL(MAX(RIGHT(msk_nomor, 5)), 0) + 1 AS next_num FROM tmsk_hdr WHERE LEFT(msk_nomor, 10) = ?;`;
  const [rows] = await pool.query(query, [prefix]);
  const nextNum = rows[0].next_num.toString().padStart(5, "0");
  return `${prefix}${nextNum}`;
};

// --- Controller Functions ---
const save = async (req, res) => {
  const payload = req.body;
  const user = req.user;
  const { header, items, isNew } = payload;
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Validasi
    if (!header.storeTujuanKode) throw new Error("Store tujuan harus diisi.");
    if (items.length === 0) throw new Error("Detail barang harus diisi.");
    if (items.some((item) => item.jumlah > item.stok))
      throw new Error("Jumlah kirim melebihi stok yang tersedia.");

    let nomorDokumen = header.nomor;
    if (isNew) {
      nomorDokumen = await generateNewNomor(user.cabang, header.tanggal);
      await connection.query(
        `INSERT INTO tmsk_hdr (msk_nomor, msk_tanggal, msk_kecab, msk_ket, user_create, date_create) VALUES (?, ?, ?, ?, ?, NOW());`,
        [
          nomorDokumen,
          header.tanggal,
          header.storeTujuanKode,
          header.keterangan,
          user.kode,
        ]
      );
    } else {
      // Logika update (jika diperlukan di masa depan)
    }

    await connection.query("DELETE FROM tmsk_dtl WHERE mskd_nomor = ?", [
      nomorDokumen,
    ]);

    if (items.length > 0) {
      const itemInsertQuery = `INSERT INTO tmsk_dtl (mskd_nomor, mskd_kode, mskd_ukuran, mskd_jumlah) VALUES ?;`;
      const itemValues = items.map((item) => [
        nomorDokumen,
        item.kode,
        item.ukuran,
        item.jumlah,
      ]);
      await connection.query(itemInsertQuery, [itemValues]);
    }

    await connection.commit();
    res
      .status(201)
      .json({
        success: true,
        message: `Data berhasil disimpan dengan nomor ${nomorDokumen}`,
        data: { nomor: nomorDokumen },
      });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in mutasiStore.save:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

const lookupTujuanStore = async (req, res) => {
  try {
    const user = req.user;
    const query = `SELECT gdg_kode AS kode, gdg_nama AS nama FROM tgudang WHERE gdg_dc = 0 AND gdg_kode <> ? ORDER BY gdg_kode;`;
    const [rows] = await pool.query(query, [user.cabang]);
    // Format agar kompatibel dengan SearchModal
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in lookupTujuanStore:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat daftar store." });
  }
};

module.exports = {
  save,
  lookupTujuanStore,
};
