const pool = require("../config/database");
const { format } = require("date-fns");

const generateNomorSesi = async (cabang, tanggal) => {
  const date = new Date(tanggal);
  const prefix = `BK-${cabang}-${format(date, "yyMM")}-`;

  const [rows] = await pool.query(
    `SELECT IFNULL(MAX(RIGHT(bt_nomor, 4)), 0) + 1 AS next_num 
     FROM tbuku_tamu_hdr WHERE bt_nomor LIKE ?`,
    [`${prefix}%`],
  );
  const nextNumber = rows[0].next_num.toString().padStart(4, "0");
  return `${prefix}${nextNumber}`;
};

// GET /api/buku-tamu/sesi — Browse daftar sesi pameran
const getSesiList = async (req, res) => {
  try {
    const { status } = req.query;
    const user = req.user;

    const params = [user.cabang];
    let query = `
      SELECT 
        h.bt_nomor AS nomor,
        h.bt_nama_acara AS namaAcara,
        h.bt_tanggal_mulai AS tanggalMulai,
        h.bt_tanggal_selesai AS tanggalSelesai,
        h.bt_status AS status,
        h.bt_cab AS cabang,
        h.user_create AS operator,
        h.date_create AS waktuBuat,
        IFNULL((SELECT COUNT(*) FROM tbuku_tamu_dtl d WHERE d.btd_hdr_nomor = h.bt_nomor), 0) AS totalTamu,
        IFNULL((SELECT COUNT(*) FROM tbuku_tamu_dtl d WHERE d.btd_hdr_nomor = h.bt_nomor AND d.btd_potential = 1), 0) AS totalPotential
      FROM tbuku_tamu_hdr h
      WHERE h.bt_cab = ?
    `;

    if (status) {
      query += " AND h.bt_status = ?";
      params.push(status);
    }

    query += " ORDER BY h.date_create DESC";

    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getSesiList:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/buku-tamu/sesi/save — Buat sesi baru pameran
const saveSesi = async (req, res) => {
  try {
    const { namaAcara, tanggalMulai } = req.body;
    const user = req.user;

    if (!namaAcara || !namaAcara.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Nama acara/lokasi wajib diisi." });
    }

    const tglMulai = tanggalMulai || format(new Date(), "yyyy-MM-dd");
    const newNomor = await generateNomorSesi(user.cabang, tglMulai);

    await pool.query(
      `INSERT INTO tbuku_tamu_hdr 
       (bt_nomor, bt_nama_acara, bt_tanggal_mulai, bt_cab, bt_status, user_create, date_create)
       VALUES (?, ?, ?, ?, 'OPEN', ?, NOW())`,
      [newNomor, namaAcara.trim(), tglMulai, user.cabang, user.kode],
    );

    res.status(201).json({
      success: true,
      message: `Sesi ${newNomor} berhasil dibuat.`,
      data: { nomor: newNomor },
    });
  } catch (error) {
    console.error("Error saveSesi:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/buku-tamu/sesi/:nomor/close — Tutup sesi pameran
const closeSesi = async (req, res) => {
  try {
    const { nomor } = req.params;
    const user = req.user;

    const [result] = await pool.query(
      `UPDATE tbuku_tamu_hdr 
       SET bt_status = 'CLOSE', bt_tanggal_selesai = CURDATE(), 
           user_modified = ?, date_modified = NOW()
       WHERE bt_nomor = ? AND bt_status = 'OPEN'`,
      [user.kode, nomor],
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({
        success: false,
        message: "Sesi tidak ditemukan atau sudah ditutup.",
      });
    }

    res.status(200).json({ success: true, message: "Sesi berhasil ditutup." });
  } catch (error) {
    console.error("Error closeSesi:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/buku-tamu/sesi/:nomor — Detail sesi + daftar tamunya
const getSesiDetail = async (req, res) => {
  try {
    const { nomor } = req.params;

    const [headerRows] = await pool.query(
      `SELECT 
        bt_nomor AS nomor, bt_nama_acara AS namaAcara, 
        bt_tanggal_mulai AS tanggalMulai, bt_tanggal_selesai AS tanggalSelesai,
        bt_status AS status, bt_cab AS cabang
       FROM tbuku_tamu_hdr WHERE bt_nomor = ?`,
      [nomor],
    );

    if (headerRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Sesi tidak ditemukan." });
    }

    const [tamuRows] = await pool.query(
      `SELECT 
        btd_idrec AS idrec, btd_urut AS urut, btd_nama AS nama,
        btd_alamat AS alamat, btd_hp AS hp, btd_potential AS potential,
        date_create AS waktuInput
       FROM tbuku_tamu_dtl WHERE btd_hdr_nomor = ? ORDER BY btd_urut ASC`,
      [nomor],
    );

    res.status(200).json({
      success: true,
      data: { header: headerRows[0], tamu: tamuRows },
    });
  } catch (error) {
    console.error("Error getSesiDetail:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/buku-tamu/sesi/:nomor/tamu — Tambah tamu baru ke sesi
const addTamu = async (req, res) => {
  try {
    const { nomor } = req.params;
    const { nama, alamat, hp, potential } = req.body;
    const user = req.user;

    if (!nama || !nama.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Nama tamu wajib diisi." });
    }

    const [sesiRows] = await pool.query(
      "SELECT bt_status FROM tbuku_tamu_hdr WHERE bt_nomor = ?",
      [nomor],
    );
    if (sesiRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Sesi tidak ditemukan." });
    }
    if (sesiRows[0].bt_status === "CLOSE") {
      return res
        .status(400)
        .json({
          success: false,
          message: "Sesi sudah ditutup, tidak bisa menambah tamu.",
        });
    }

    const [maxUrut] = await pool.query(
      "SELECT IFNULL(MAX(btd_urut), 0) + 1 AS next_urut FROM tbuku_tamu_dtl WHERE btd_hdr_nomor = ?",
      [nomor],
    );
    const urut = maxUrut[0].next_urut;
    const idrec = `${nomor}-${String(urut).padStart(4, "0")}`;

    await pool.query(
      `INSERT INTO tbuku_tamu_dtl 
       (btd_idrec, btd_hdr_nomor, btd_urut, btd_nama, btd_alamat, btd_hp, btd_potential, user_create, date_create)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        idrec,
        nomor,
        urut,
        nama.trim(),
        alamat || "",
        hp || "",
        potential ? 1 : 0,
        user.kode,
      ],
    );

    res.status(201).json({
      success: true,
      message: "Tamu berhasil ditambahkan.",
      data: { idrec, urut },
    });
  } catch (error) {
    console.error("Error addTamu:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/buku-tamu/tamu/:idrec — Edit data tamu
const updateTamu = async (req, res) => {
  try {
    const { idrec } = req.params;
    const { nama, alamat, hp, potential } = req.body;
    const user = req.user;

    if (!nama || !nama.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Nama tamu wajib diisi." });
    }

    const [result] = await pool.query(
      `UPDATE tbuku_tamu_dtl 
       SET btd_nama = ?, btd_alamat = ?, btd_hp = ?, btd_potential = ?,
           user_modified = ?, date_modified = NOW()
       WHERE btd_idrec = ?`,
      [
        nama.trim(),
        alamat || "",
        hp || "",
        potential ? 1 : 0,
        user.kode,
        idrec,
      ],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data tamu tidak ditemukan." });
    }

    res
      .status(200)
      .json({ success: true, message: "Data tamu berhasil diperbarui." });
  } catch (error) {
    console.error("Error updateTamu:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/buku-tamu/tamu/:idrec/toggle-potential
const togglePotential = async (req, res) => {
  try {
    const { idrec } = req.params;
    const user = req.user;

    const [rows] = await pool.query(
      "SELECT btd_potential FROM tbuku_tamu_dtl WHERE btd_idrec = ?",
      [idrec],
    );
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data tamu tidak ditemukan." });
    }

    const newValue = rows[0].btd_potential === 1 ? 0 : 1;
    await pool.query(
      `UPDATE tbuku_tamu_dtl SET btd_potential = ?, user_modified = ?, date_modified = NOW() 
       WHERE btd_idrec = ?`,
      [newValue, user.kode, idrec],
    );

    res.status(200).json({
      success: true,
      message: "Status potential berhasil diubah.",
      data: { potential: newValue },
    });
  } catch (error) {
    console.error("Error togglePotential:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/buku-tamu/tamu/:idrec
const deleteTamu = async (req, res) => {
  try {
    const { idrec } = req.params;
    const [result] = await pool.query(
      "DELETE FROM tbuku_tamu_dtl WHERE btd_idrec = ?",
      [idrec],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data tamu tidak ditemukan." });
    }

    res
      .status(200)
      .json({ success: true, message: "Data tamu berhasil dihapus." });
  } catch (error) {
    console.error("Error deleteTamu:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getSesiList,
  saveSesi,
  closeSesi,
  getSesiDetail,
  addTamu,
  updateTamu,
  togglePotential,
  deleteTamu,
};
