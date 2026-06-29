const pool = require("../config/database");
const { format } = require("date-fns");

/**
 * Menghasilkan nomor Mutasi Stok (MSO) baru menggunakan koneksi transaksi aktif.
 */
const generateNewMsoNumber = async (connection, cabang, tanggal) => {
  const date = new Date(tanggal);
  const prefix = `${cabang}MSO${format(date, "yyMM")}`;
  const query = `
    SELECT IFNULL(MAX(RIGHT(mso_nomor, 5)), 0) + 1 AS next_num
    FROM tmutasistok_hdr 
    WHERE mso_nomor LIKE ?;
  `;
  const [rows] = await connection.query(query, [`${prefix}%`]);
  const nextNumber = rows[0].next_num.toString().padStart(5, "0");
  return `${prefix}${nextNumber}`;
};

/**
 * Menghasilkan nomor MSI baru menggunakan koneksi transaksi aktif.
 */
const generateNewMsodNomorIn = async (connection, cabang, tanggal) => {
  const aym = format(new Date(tanggal), "yyMM");
  const prefix = `${cabang}MSI${aym}`;
  const query = `
    SELECT IFNULL(MAX(RIGHT(msod_nomorin, 5)), 0) + 1 AS next_num
    FROM tmutasistok_dtl 
    WHERE LEFT(msod_nomorin, 10) = ?;
  `;
  const [rows] = await connection.query(query, [prefix]);
  const nextNumber = rows[0].next_num.toString().padStart(5, "0");
  return `${prefix}${nextNumber}`;
};

/**
 * Mengambil daftar Surat Pesanan (Browse) khusus aplikasi mobile dengan filter cabang user.
 */
const getList = async (req, res) => {
  try {
    const user = req.user;
    const { startDate, endDate, term } = req.query;

    let query = `
      SELECT 
        h.so_nomor AS nomor_so, 
        h.so_tanggal AS tanggal, 
        c.cus_nama AS customer_nama,
        h.so_status AS status
      FROM tso_hdr h
      LEFT JOIN tcustomer c ON c.cus_kode = h.so_cus_kode
      WHERE h.so_cab = ? AND h.so_aktif = 'Y' AND h.so_close = 0
    `;
    const params = [user.cabang];

    if (startDate && endDate) {
      query += ` AND h.so_tanggal BETWEEN ? AND ?`;
      params.push(startDate, endDate);
    }

    if (term) {
      query += ` AND (h.so_nomor LIKE ? OR c.cus_nama LIKE ?)`;
      params.push(`%${term}%`, `%${term}%`);
    }

    query += ` ORDER BY h.so_tanggal DESC, h.so_nomor DESC LIMIT 50`;

    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error Mobile SO GetList:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Memuat detail item dari SO untuk kebutuhan layar scanner mobile.
 */
const getDetails = async (req, res) => {
  try {
    const { nomor } = req.params;

    const query = `
      SELECT 
        d.sod_kode,
        IFNULL(b.brgd_barcode, '') AS barcode,
        TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama_barang,
        d.sod_ukuran,
        d.sod_jumlah,
        d.sod_scanned
      FROM tso_dtl d
      LEFT JOIN tbarangdc a ON a.brg_kode = d.sod_kode
      LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.sod_kode AND b.brgd_ukuran = d.sod_ukuran
      WHERE d.sod_so_nomor = ?
      ORDER BY d.sod_nourut
    `;

    const [rows] = await pool.query(query, [nomor]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error Mobile SO GetDetails:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Eksekusi mutasi otomatis berbasis scan barcode via aplikasi mobile.
 */
const autoMutasiScan = async (req, res) => {
  const { nomor_so, kode_barang, ukuran, qty } = req.body;
  const user = req.user;

  if (!nomor_so || !kode_barang || !ukuran || !qty) {
    return res
      .status(400)
      .json({ success: false, message: "Data scan tidak lengkap." });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const cabang = user.cabang;
    const tanggal = format(new Date(), "yyyy-MM-dd");

    // 1. AMBIL STATUS ITEM DI SO SAAT INI
    const [itemSo] = await connection.query(
      `
      SELECT  
        sod_jumlah,
        sod_scanned,
        IFNULL((
          SELECT SUM(m.mst_stok_in - m.mst_stok_out) 
          FROM tmasterstokso m 
          WHERE m.mst_aktif = 'Y' AND m.mst_cab = ? 
            AND m.mst_brg_kode = ? AND m.mst_ukuran = ? 
            AND m.mst_nomor_so = ?
        ), 0) AS total_mutasi
      FROM tso_dtl
      WHERE sod_so_nomor = ? AND sod_kode = ? AND sod_ukuran = ? LIMIT 1
      `,
      [cabang, kode_barang, ukuran, nomor_so, nomor_so, kode_barang, ukuran],
    );

    if (itemSo.length === 0) {
      throw new Error(
        "Barang tidak ditemukan di dalam dokumen Surat Pesanan ini.",
      );
    }

    const sod_jumlah = itemSo[0].sod_jumlah;
    const sod_scanned = itemSo[0].sod_scanned;
    const total_mutasi = itemSo[0].total_mutasi;

    const new_scanned = sod_scanned + qty;

    if (new_scanned > sod_jumlah) {
      throw new Error(
        `Gagal: Qty scan (${new_scanned}) melebihi jumlah pesanan (${sod_jumlah}).`,
      );
    }

    // 2. UPDATE PROGRESS SCAN DI tso_dtl
    await connection.query(
      "UPDATE tso_dtl SET sod_scanned = ? WHERE sod_so_nomor = ? AND sod_kode = ? AND sod_ukuran = ?",
      [new_scanned, nomor_so, kode_barang, ukuran],
    );

    // 3. HITUNG BERAPA YANG PERLU DIMUTASI
    const qty_to_mutate = Math.max(0, new_scanned - total_mutasi);
    let msoNomor = null;

    if (qty_to_mutate > 0) {
      const [existingMso] = await connection.query(
        `SELECT mso_nomor, mso_idrec FROM tmutasistok_hdr 
         WHERE mso_so_nomor = ? AND mso_tanggal = ? AND mso_jenis = 'SP' AND mso_cab = ? LIMIT 1`,
        [nomor_so, tanggal, cabang],
      );

      let idrec;

      if (existingMso.length > 0) {
        msoNomor = existingMso[0].mso_nomor;
        idrec = existingMso[0].mso_idrec;
      } else {
        msoNomor = await generateNewMsoNumber(connection, cabang, tanggal);
        idrec = `${cabang}MSO${format(new Date(), "yyyyMMddHHmmssSSS")}`;
        await connection.query(
          `INSERT INTO tmutasistok_hdr (
            mso_idrec, mso_nomor, mso_tanggal, mso_so_nomor, mso_ket, mso_jenis, mso_cab, user_create, date_create
          ) VALUES (?, ?, ?, ?, ?, 'SP', ?, ?, NOW())`,
          [
            idrec,
            msoNomor,
            tanggal,
            nomor_so,
            "AUTO-MUTASI SCAN BARCODE MOBILE",
            cabang,
            user.kode,
          ],
        );
      }

      const [existingDetail] = await connection.query(
        `SELECT msod_nomorin, msod_nourut, msod_jumlah 
         FROM tmutasistok_dtl 
         WHERE msod_nomor = ? AND msod_kode = ? AND msod_ukuran = ? LIMIT 1`,
        [msoNomor, kode_barang, ukuran],
      );

      if (existingDetail.length > 0) {
        const currentQty = existingDetail[0].msod_jumlah;
        const newQty = currentQty + qty_to_mutate;
        const msodNomorIn = existingDetail[0].msod_nomorin;
        const nourut = existingDetail[0].msod_nourut;

        await connection.query(
          `UPDATE tmutasistok_dtl SET msod_jumlah = ? WHERE msod_nomor = ? AND msod_kode = ? AND msod_ukuran = ?`,
          [newQty, msoNomor, kode_barang, ukuran],
        );

        const idrecMaster = `${msoNomor}${nourut}`;
        await connection.query(
          `UPDATE tmasterstok SET mst_stok_out = ? WHERE mst_idrec = ?`,
          [newQty, idrecMaster],
        );

        const idrecMasterSo = `${msodNomorIn}${nourut}`;
        await connection.query(
          `UPDATE tmasterstokso SET mst_stok_in = ? WHERE mst_idrec = ?`,
          [newQty, idrecMasterSo],
        );
      } else {
        const [urutRows] = await connection.query(
          "SELECT IFNULL(MAX(msod_nourut), 0) + 1 AS nextUrut FROM tmutasistok_dtl WHERE msod_nomor = ?",
          [msoNomor],
        );
        const nextUrut = urutRows[0].nextUrut;
        const msodNomorIn = await generateNewMsodNomorIn(
          connection,
          cabang,
          tanggal,
        );

        await connection.query(
          `INSERT INTO tmutasistok_dtl (
            msod_idrec, msod_nomor, msod_nomorin, msod_kode, msod_ukuran, msod_jumlah, msod_nourut
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            idrec,
            msoNomor,
            msodNomorIn,
            kode_barang,
            ukuran,
            qty_to_mutate,
            nextUrut,
          ],
        );
      }
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message:
        qty_to_mutate > 0
          ? `Item otomatis dimutasi ke dokumen ${msoNomor}`
          : `Item berhasil discan (Mutasi di-skip karena sudah tercover mutasi manual).`,
      mso_nomor: msoNomor,
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error Auto Mutasi Scan Mobile Controller:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal mengeksekusi Auto-Mutasi di database: " + error.message,
    });
  } finally {
    connection.release();
  }
};

module.exports = {
  getList,
  getDetails,
  autoMutasiScan,
};
