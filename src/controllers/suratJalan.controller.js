const pool = require("../config/database");

// --- Helper Function ---
const generateNewSjNumber = async (gudang, tanggal) => {
  const [year, month] = tanggal.split("-");
  const prefix = `${gudang}.SJ.${year.substring(2)}${month}.`;

  const query = `
        SELECT IFNULL(MAX(RIGHT(sj_nomor, 4)), 0) + 1 AS next_num
        FROM tdc_sj_hdr 
        WHERE sj_nomor LIKE ?;
    `;
  const [rows] = await pool.query(query, [`${prefix}%`]);
  const nextNumber = rows[0].next_num.toString().padStart(4, "0");

  return `${prefix}${nextNumber}`;
};

// --- Controller Functions ---

const saveData = async (req, res) => {
  const payload = req.body;
  const user = req.user;
  const { header, items, isNew } = payload;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    if (!header.gudang?.kode) throw new Error("Gudang harus diisi.");
    if (!header.store?.kode) throw new Error("Store tujuan harus diisi.");
    if (items.length === 0) throw new Error("Detail barang harus diisi.");

    let sjNomor = header.nomor;

    if (isNew) {
      sjNomor = await generateNewSjNumber(header.gudang.kode, header.tanggal);
      const nomorPermintaan = header.permintaan || "";
      await connection.query(
        `INSERT INTO tdc_sj_hdr (sj_nomor, sj_tanggal, sj_kecab, sj_cab, sj_mt_nomor, sj_ket, user_create, date_create) VALUES (?, ?, ?, ?, ?, ?, ?, NOW());`,
        [
          sjNomor,
          header.tanggal,
          header.store.kode,
          user.cabang,
          nomorPermintaan,
          header.keterangan,
          user.kode,
        ]
      );
    } else {
      await connection.query(
        `UPDATE tdc_sj_hdr SET sj_tanggal = ?, sj_kecab = ?, sj_ket = ?, user_modified = ?, date_modified = NOW() WHERE sj_nomor = ?;`,
        [
          header.tanggal,
          header.store.kode,
          header.keterangan,
          user.kode,
          sjNomor,
        ]
      );
    }

    await connection.query("DELETE FROM tdc_sj_dtl WHERE sjd_nomor = ?", [
      sjNomor,
    ]);

    const detailValues = items
      .filter((item) => item.kode && item.jumlah > 0)
      .map((item, index) => {
        const nourut = index + 1;
        const iddrec = `${sjNomor}${nourut}`;
        return [iddrec, sjNomor, item.kode, item.ukuran, item.jumlah];
      });

    if (detailValues.length > 0) {
      await connection.query(
        `INSERT INTO tdc_sj_dtl (sjd_iddrec, sjd_nomor, sjd_kode, sjd_ukuran, sjd_jumlah) VALUES ?;`,
        [detailValues]
      );
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: `Surat Jalan ${sjNomor} berhasil disimpan.`,
      data: { nomor: sjNomor },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in saveData:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

const getItemsForLoad = async (req, res) => {
  try {
    const { nomor, gudang } = req.query;
    if (!nomor || !gudang) {
      return res.status(400).json({
        success: false,
        message: 'Parameter "nomor" dan "gudang" diperlukan.',
      });
    }

    let query = "";
    const params = [gudang, nomor];
    if (nomor.includes("RB")) {
      query = `SELECT d.rbd_kode AS kode, b.brgd_barcode AS barcode, TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama, d.rbd_ukuran AS ukuran, d.rbd_jumlah AS jumlah, IFNULL((SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m WHERE m.mst_aktif="Y" AND m.mst_cab=? AND m.mst_brg_kode=d.rbd_kode AND m.mst_ukuran=d.rbd_ukuran), 0) AS stok FROM tdcrb_dtl d LEFT JOIN tbarangdc a ON a.brg_kode = d.rbd_kode LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.rbd_kode AND b.brgd_ukuran = d.rbd_ukuran WHERE d.rbd_nomor = ?;`;
    } else {
      query = `SELECT d.mtd_kode AS kode, b.brgd_barcode AS barcode, TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama, d.mtd_ukuran AS ukuran, d.mtd_jumlah AS minta, IFNULL(b.brgd_min, 0) AS minstok, IFNULL(b.brgd_max, 0) AS maxstok, IFNULL((SELECT SUM(sjd.sjd_jumlah) FROM tdc_sj_dtl sjd JOIN tdc_sj_hdr sjh ON sjd.sjd_nomor = sjh.sj_nomor WHERE sjh.sj_mt_nomor = d.mtd_nomor AND sjd.sjd_kode = d.mtd_kode AND sjd.sjd_ukuran = d.mtd_ukuran), 0) AS sudah, IFNULL((SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m WHERE m.mst_aktif="Y" AND m.mst_cab=? AND m.mst_brg_kode=d.mtd_kode AND m.mst_ukuran=d.mtd_ukuran), 0) AS stok FROM tmintabarang_dtl d LEFT JOIN tbarangdc a ON a.brg_kode = d.mtd_kode LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.mtd_kode AND b.brgd_ukuran = d.mtd_ukuran WHERE d.mtd_nomor = ?;`;
    }
    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error in getItemsForLoad:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const loadForEdit = async (req, res) => {
  try {
    const { nomor } = req.params;
    const user = req.user;

    const headerQuery = `SELECT h.sj_nomor AS nomor, h.sj_tanggal AS tanggal, h.sj_ket AS keterangan, h.sj_mt_nomor AS permintaan, h.sj_cab AS gudang_kode, g.gdg_nama AS gudang_nama, h.sj_kecab AS store_kode, s.gdg_nama AS store_nama FROM tdc_sj_hdr h LEFT JOIN tgudang g ON g.gdg_kode = h.sj_cab LEFT JOIN tgudang s ON s.gdg_kode = h.sj_kecab WHERE h.sj_nomor = ?;`;
    const [headerRows] = await pool.query(headerQuery, [nomor]);
    if (headerRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data tidak ditemukan" });
    }

    const itemsQuery = `SELECT d.sjd_kode AS kode, b.brgd_barcode AS barcode, TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama, d.sjd_ukuran AS ukuran, d.sjd_jumlah AS jumlah, IFNULL((SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m WHERE m.mst_aktif="Y" AND m.mst_cab=? AND m.mst_brg_kode=d.sjd_kode AND m.mst_ukuran=d.sjd_ukuran), 0) AS stok FROM tdc_sj_dtl d LEFT JOIN tbarangdc a ON a.brg_kode = d.sjd_kode LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.sjd_kode AND b.brgd_ukuran = d.sjd_ukuran WHERE d.sjd_nomor = ?;`;
    const [items] = await pool.query(itemsQuery, [user.cabang, nomor]);

    res
      .status(200)
      .json({ success: true, data: { header: headerRows[0], items } });
  } catch (error) {
    console.error("Error in loadForEdit:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const searchStores = async (req, res) => {
  try {
    const { term, page = 1, itemsPerPage = 10, excludeBranch } = req.query;
    const offset = (page - 1) * itemsPerPage;
    const searchTerm = `%${term || ""}%`;

    let whereConditions = [];
    let params = [];

    if (excludeBranch) {
      whereConditions.push("gdg_dc = 0 AND gdg_kode <> ?");
      params.push(excludeBranch);
    } else {
      whereConditions.push("(gdg_dc = 0 OR gdg_dc = 3)");
    }

    whereConditions.push(`(gdg_kode LIKE ? OR gdg_nama LIKE ?)`);
    params.push(searchTerm, searchTerm);

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM tgudang ${whereClause}`,
      params
    );

    const [items] = await pool.query(
      `SELECT gdg_kode AS kode, gdg_nama AS nama FROM tgudang ${whereClause} ORDER BY gdg_kode LIMIT ? OFFSET ?;`,
      [...params, parseInt(itemsPerPage), parseInt(offset)]
    );

    res.status(200).json({ success: true, data: { items, total } });
  } catch (error) {
    console.error("Error in searchStores:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const searchPermintaan = async (req, res) => {
  try {
    const { term, storeKode, page = 1, itemsPerPage = 10 } = req.query;
    if (!storeKode) {
      return res
        .status(400)
        .json({ success: false, message: "Store tujuan harus dipilih." });
    }

    const offset = (page - 1) * itemsPerPage;
    const searchTerm = `%${term || ""}%`;
    const params = [storeKode, searchTerm, searchTerm, searchTerm, searchTerm];

    const baseFrom = `FROM tmintabarang_hdr h WHERE mt_cab = ? AND h.mt_nomor NOT IN (SELECT sj_mt_nomor FROM tdc_sj_hdr WHERE sj_mt_nomor <> "")`;
    const searchWhere = `AND (h.mt_nomor LIKE ? OR h.mt_tanggal LIKE ? OR h.mt_otomatis LIKE ? OR h.mt_ket LIKE ?)`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${baseFrom} ${searchWhere}`,
      params
    );

    const dataQuery = `SELECT h.mt_nomor AS nomor, h.mt_tanggal AS tanggal, h.mt_otomatis AS otomatis, h.mt_ket AS keterangan ${baseFrom} ${searchWhere} ORDER BY h.date_create DESC LIMIT ? OFFSET ?;`;
    const dataParams = [...params, parseInt(itemsPerPage), parseInt(offset)];
    const [items] = await pool.query(dataQuery, dataParams);

    res.status(200).json({ success: true, data: { items, total } });
  } catch (error) {
    console.error("Error in searchPermintaan:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari permintaan." });
  }
};

const searchTerimaRb = async (req, res) => {
  try {
    const { term, page = 1, itemsPerPage = 10 } = req.query;
    const user = req.user;
    const offset = (page - 1) * itemsPerPage;
    const searchTerm = `%${term || ""}%`;
    const params = [user.cabang, searchTerm, searchTerm, searchTerm];

    const baseQuery = `FROM tdcrb_hdr h LEFT JOIN trbdc_hdr r ON r.rb_noterima = h.rb_nomor LEFT JOIN tgudang g ON g.gdg_kode = h.rb_cab WHERE h.rb_cab = ? AND (h.rb_nomor LIKE ? OR r.rb_nomor LIKE ? OR g.gdg_nama LIKE ?)`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${baseQuery}`,
      params
    );
    const [items] = await pool.query(
      `SELECT h.rb_nomor AS nomor, h.rb_tanggal AS tanggal, r.rb_nomor AS no_rb, r.rb_tanggal AS tgl_rb, CONCAT(h.rb_cab, ' - ', g.gdg_nama) AS dari_store ${baseQuery} ORDER BY h.date_create DESC LIMIT ? OFFSET ?;`,
      [...params, parseInt(itemsPerPage), parseInt(offset)]
    );

    res.status(200).json({ success: true, data: { items, total } });
  } catch (error) {
    console.error("Error in searchTerimaRb:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const getItemsFromPacking = async (req, res) => {
  try {
    const { packNomor } = req.params;
    const { cabang: gudang } = req.user; // Ambil info gudang dari user KDC yang login

    // Query untuk mengambil semua item dari tpacking_dtl
    // dan menggabungkannya untuk mendapatkan detail lengkap
    const query = `
            SELECT
                d.packd_barcode AS barcode,
                b.brgd_kode AS kode,
                TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
                d.size AS ukuran,
                d.packd_qty AS qty,
                IFNULL((
                    SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m
                    WHERE m.mst_aktif = 'Y' AND m.mst_cab = ? AND m.mst_brg_kode = b.brgd_kode AND m.mst_ukuran = d.size
                ), 0) AS stok
            FROM tpacking_dtl d
            JOIN tbarangdc_dtl b ON d.packd_barcode = b.brgd_barcode
            JOIN tbarangdc h ON b.brgd_kode = h.brg_kode
            WHERE d.packd_pack_nomor = ?;
        `;

    const [items] = await pool.query(query, [gudang, packNomor]);

    if (items.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Nomor Packing tidak ditemukan atau tidak memiliki item.",
      });
    }

    res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("Error in getItemsFromPacking:", error);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server." });
  }
};

const getSuratJalanHistory = async (req, res) => {
  try {
    const { cabang: userCabang } = req.user;
    const { startDate, endDate } = req.query; // Menerima filter tanggal

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Filter tanggal (startDate dan endDate) diperlukan.",
      });
    }

    const query = `
      SELECT 
        h.sj_nomor AS nomor,
        h.sj_tanggal AS tanggal,
        h.sj_kecab AS store_kode,
        g.gdg_nama AS store_nama,
        (SELECT COUNT(*) FROM tdc_sj_dtl d WHERE d.sjd_nomor = h.sj_nomor) AS jumlah_jenis_item,
        (SELECT SUM(d.sjd_jumlah) FROM tdc_sj_dtl d WHERE d.sjd_nomor = h.sj_nomor) AS total_qty
      FROM tdc_sj_hdr h
      LEFT JOIN tgudang g ON h.sj_kecab = g.gdg_kode
        WHERE 
          h.sj_cab = ? 
          AND h.sj_tanggal BETWEEN ? AND ?
      ORDER BY h.sj_tanggal DESC, h.sj_nomor DESC;
    `;

    const [rows] = await pool.query(query, [userCabang, startDate, endDate]);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error in getSuratJalanHistory:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil riwayat Surat Jalan.",
    });
  }
};

module.exports = {
  saveData,
  getItemsForLoad,
  loadForEdit,
  searchStores,
  searchPermintaan,
  searchTerimaRb,
  getItemsFromPacking,
  getSuratJalanHistory,
};
