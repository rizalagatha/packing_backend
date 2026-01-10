const pool = require("../config/database");
const { format } = require("date-fns");

// Helper untuk generate nomor otomatis
const getNomor = async (connection, prefix, table, column, type = "SJ") => {
  const formattedPrefix = `${prefix}.${type}.${format(new Date(), "yyMM")}`;
  const query = `SELECT IFNULL(MAX(RIGHT(${column}, 4)), 0) as max_nomor FROM ${table} WHERE LEFT(${column}, 11) = ?`;
  const [rows] = await connection.query(query, [formattedPrefix]);
  const nextNumber = parseInt(rows[0].max_nomor, 10) + 1;
  return `${formattedPrefix}.${String(nextNumber).padStart(4, "0")}`;
};

const lookupProductByBarcode = async (req, res) => {
  try {
    const { barcode, gudang } = req.query;
    const query = `
            SELECT 
                b.brgd_kode AS kode, b.brgd_barcode AS barcode, b.brgd_ukuran AS ukuran,
                TRIM(CONCAT_WS(' ', a.brg_jeniskaos, a.brg_tipe, a.brg_lengan, a.brg_jeniskain, a.brg_warna)) AS nama,
                IFNULL((SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m 
                WHERE m.mst_aktif = "Y" AND m.mst_cab = ? AND m.mst_brg_kode = b.brgd_kode AND m.mst_ukuran = b.brgd_ukuran), 0) AS stok
            FROM tbarangdc_dtl b
            INNER JOIN tbarangdc a ON a.brg_kode = b.brgd_kode
            WHERE a.brg_aktif = 0 AND b.brgd_barcode = ?;
        `;
    const [rows] = await pool.query(query, [gudang, barcode]);
    if (rows.length === 0) throw new Error("Barcode tidak ditemukan.");
    res.json(rows[0]);
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
};

const saveData = async (req, res) => {
  const { header, items, approver } = req.body;
  const user = req.user;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Generate Nomor SJ (KDC) dan TJ (Store Tujuan)
    const nomorSJ = await getNomor(
      connection,
      header.gudangKode,
      "tdc_sj_hdr",
      "sj_nomor",
      "SJ"
    );
    const nomorTerima = await getNomor(
      connection,
      header.storeKode,
      "ttrm_sj_hdr",
      "tj_nomor",
      "TJ"
    );

    // 2. Simpan Header SJ (KDC)
    await connection.query(
      `INSERT INTO tdc_sj_hdr (sj_nomor, sj_tanggal, sj_noterima, sj_kecab, sj_peminta, user_create, date_create) 
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        nomorSJ,
        header.tanggal,
        nomorTerima,
        header.storeKode,
        header.peminta,
        user.kode,
      ]
    );

    // 3. Simpan Header TJ (Terima Toko)
    await connection.query(
      `INSERT INTO ttrm_sj_hdr (tj_nomor, tj_tanggal, user_create, date_create) VALUES (?, ?, ?, NOW())`,
      [nomorTerima, header.tanggal, user.kode]
    );

    // 4. Simpan Detail Items
    for (const item of items) {
      await connection.query(
        `INSERT INTO tdc_sj_dtl (sjd_nomor, sjd_kode, sjd_ukuran, sjd_jumlah) VALUES (?, ?, ?, ?)`,
        [nomorSJ, item.kode, item.ukuran, item.jumlah]
      );
      await connection.query(
        `INSERT INTO ttrm_sj_dtl (tjd_nomor, tjd_kode, tjd_ukuran, tjd_jumlah) VALUES (?, ?, ?, ?)`,
        [nomorTerima, item.kode, item.ukuran, item.jumlah]
      );
    }

    await connection.commit();
    res
      .status(201)
      .json({
        success: true,
        message: `Berhasil disimpan: ${nomorSJ}`,
        nomor: nomorSJ,
      });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

module.exports = { lookupProductByBarcode, saveData };
