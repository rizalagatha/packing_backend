const pool = require("../config/database");
const { format } = require("date-fns");

// --- HELPER: GENERATE NOMOR ---
const generateNomor = async (connection, jenis, tanggal) => {
  const year = format(new Date(tanggal), "yyyy");
  const prefix = jenis === "OBAT" ? `MIO${year}.` : `MIA${year}.`;

  const query = `
    SELECT IFNULL(MAX(CAST(RIGHT(min_nomor, 5) AS UNSIGNED)), 0) + 1 AS next_num
    FROM kencanaprintnew.tgarmenminta_hdr 
    WHERE min_nomor LIKE ?;
  `;
  const [rows] = await connection.query(query, [`${prefix}%`]);
  const nextNumber = rows[0].next_num.toString().padStart(5, "0");

  return `${prefix}${nextNumber}`;
};

// GET /api/minta-bahan-form/search-barang?keyword=&jenis=
// Lookup barang (F1) — dipanggil dari SearchModal di form
const searchBarang = async (req, res) => {
  try {
    const { keyword, jenis } = req.query;
    const cabang = "P03"; // Terkunci P03, sama seperti web

    if (!jenis || !["ACCESORIES", "OBAT"].includes(jenis)) {
      return res.status(400).json({
        success: false,
        message: "Parameter jenis wajib diisi (ACCESORIES atau OBAT).",
      });
    }

    const searchTerm = `%${keyword || ""}%`;

    let ktgFilter = "";
    let stockTable = "kencanaprintnew.tmasterstok_acc";

    if (jenis === "ACCESORIES") {
      ktgFilter = `AND b.brg_ktg = 'STORE'`;
      stockTable = "kencanaprintnew.tmasterstok_acc";
    } else if (jenis === "OBAT") {
      ktgFilter = `AND b.brg_ktg = 'DTF'`;
      stockTable = "kencanaprintnew.tmasterstok_obat";
    }

    const query = `
      SELECT 
        b.brg_kode AS kode, 
        b.brg_nama AS nama, 
        b.brg_satuan AS satuan, 
        b.brg_note AS note,
        IFNULL((
          SELECT SUM(m.mst_stok_in - m.mst_stok_out) 
          FROM ${stockTable} m 
          WHERE m.mst_aktif = 'Y' 
            AND m.mst_cab = ? 
            AND m.mst_brg_kode = b.brg_kode
        ), 0) AS stok
      FROM kencanaprintnew.tgarmen_brg b
      WHERE b.brg_aktif = 'Y' 
        AND b.brg_jenis = ?
        ${ktgFilter}
        AND (b.brg_kode LIKE ? OR b.brg_nama LIKE ?)
      ORDER BY b.brg_nama ASC
    `;

    const [rows] = await pool.query(query, [
      cabang,
      jenis,
      searchTerm,
      searchTerm,
    ]);

    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error searchBarang mintaBahanForm:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/minta-bahan-form/:nomor  (Load untuk mode Edit)
const getForEdit = async (req, res) => {
  try {
    const { nomor } = req.params;

    const headerQuery = `
      SELECT 
        min_nomor AS nomor,
        min_tanggal AS tanggal,
        min_cab AS cabang,
        min_jenis AS jenis,
        min_ket AS keterangan,
        min_close,
        user_create
      FROM kencanaprintnew.tgarmenminta_hdr
      WHERE min_nomor = ?
    `;
    const [headerRows] = await pool.query(headerQuery, [nomor]);
    if (headerRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data permintaan tidak ditemukan." });
    }

    const detailQuery = `
      SELECT 
        d.mind_brg_kode AS kode,
        b.brg_nama AS nama,
        b.brg_satuan AS satuan,
        d.mind_jumlah AS jumlah,
        d.mind_ket AS keterangan
      FROM kencanaprintnew.tgarmenminta_dtl d
      LEFT JOIN kencanaprintnew.tgarmen_brg b ON b.brg_kode = d.mind_brg_kode
      WHERE d.mind_nomor = ?
      ORDER BY d.mind_urut ASC
    `;
    const [itemRows] = await pool.query(detailQuery, [nomor]);

    res.status(200).json({
      success: true,
      data: {
        header: headerRows[0],
        items: itemRows,
      },
    });
  } catch (error) {
    console.error("Error getForEdit mintaBahanForm:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/minta-bahan-form/save  (Create / Update)
const save = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { header, items, isNew } = req.body;
    const user = req.user;

    if (!header || !header.tanggal) {
      throw new Error("Tanggal permintaan wajib diisi.");
    }

    // Terkunci di P03, sama seperti web
    const cabang = "P03";
    const jenis = header.jenis || "ACCESORIES";
    if (!["ACCESORIES", "OBAT"].includes(jenis)) {
      throw new Error("Jenis permintaan tidak valid.");
    }
    // [CATATAN] req.user.bagian tidak ada di payload JWT mobile saat ini,
    // jadi ini akan selalu kosong sampai ditambahkan ke token / di-lookup.
    const bagianUser = user.bagian ? user.bagian.toUpperCase() : "";

    let nomorPermintaan = header.nomor;

    if (isNew) {
      nomorPermintaan = await generateNomor(connection, jenis, header.tanggal);

      await connection.query(
        `INSERT INTO kencanaprintnew.tgarmenminta_hdr 
         (min_jenis, min_nomor, min_tanggal, min_cab, min_bagian, min_ket, date_create, user_create, min_close) 
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, 0)`,
        [
          jenis,
          nomorPermintaan,
          header.tanggal,
          cabang,
          bagianUser,
          header.keterangan || "",
          user.kode,
        ],
      );
    } else {
      const [cekRows] = await connection.query(
        `SELECT min_close FROM kencanaprintnew.tgarmenminta_hdr WHERE min_nomor = ?`,
        [nomorPermintaan],
      );
      if (cekRows.length === 0) throw new Error("Data tidak ditemukan.");
      if (cekRows[0].min_close !== 0) {
        throw new Error("Data sudah diproses/diclose, tidak bisa diubah.");
      }

      await connection.query(
        `UPDATE kencanaprintnew.tgarmenminta_hdr SET 
           min_tanggal = ?, 
           min_ket = ?, 
           date_modified = NOW(), 
           user_modified = ? 
         WHERE min_nomor = ?`,
        [header.tanggal, header.keterangan || "", user.kode, nomorPermintaan],
      );

      await connection.query(
        `DELETE FROM kencanaprintnew.tgarmenminta_dtl WHERE mind_nomor = ?`,
        [nomorPermintaan],
      );
    }

    // Insert Detail Items
    const validItems = (items || []).filter(
      (item) => item.kode && Number(item.jumlah) > 0,
    );
    if (validItems.length === 0) {
      throw new Error("Detail barang tidak boleh kosong atau jumlah = 0.");
    }

    let noUrut = 1;
    const detailValues = validItems.map((item) => [
      nomorPermintaan,
      item.kode,
      parseFloat(item.jumlah).toFixed(2),
      0,
      0,
      item.keterangan || "",
      noUrut++,
    ]);

    await connection.query(
      `INSERT INTO kencanaprintnew.tgarmenminta_dtl 
       (mind_nomor, mind_brg_kode, mind_jumlah, mind_pcs, mind_pemakaian, mind_ket, mind_urut) 
       VALUES ?`,
      [detailValues],
    );

    await connection.commit();
    res.status(200).json({
      success: true,
      message: `Permintaan ${nomorPermintaan} berhasil disimpan.`,
      data: { nomor: nomorPermintaan },
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error save mintaBahanForm:", error);
    const isValidationError = [
      "wajib diisi",
      "tidak boleh kosong",
      "tidak ditemukan",
      "tidak valid",
      "sudah diproses",
    ].some((msg) => error.message.toLowerCase().includes(msg));
    res
      .status(isValidationError ? 400 : 500)
      .json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

module.exports = {
  searchBarang,
  getForEdit,
  save,
};
