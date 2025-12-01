const pool = require("../config/database");
const { format } = require("date-fns");

// --- FUNGSI PENDUKUNG DARI REFERENSI ANDA ---

// 1. getBufferStokItems (Untuk load otomatis barang di bawah buffer)
const getBufferStokItems = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const user = req.user;
    const cab = user.cabang;

    // Ensure cab is valid
    if (!cab) {
      throw new Error("Cabang user tidak valid.");
    }

    // Determine the category filter part directly in JS to keep SQL clean
    const categoryFilter =
      cab === "K04" ? 'AND a.brg_ktg <> ""' : 'AND a.brg_ktg = ""';

    const query = `
      SELECT 
        y.Kode as kode,
        y.Barcode as barcode,
        y.Nama as nama,
        y.Ukuran as ukuran,
        y.StokMinimal AS stokmin,
        y.StokMaximal AS stokmax,
        y.sudahminta,
        y.sj,
        y.Stok AS stok,
        (y.StokMaximal - (y.Stok + y.sudahminta + y.sj)) AS mino
      FROM (
        SELECT
          x.Kode, x.Barcode, x.Nama, x.Ukuran, x.StokMinimal, x.StokMaximal,
          
          /* sudah minta */
          IFNULL((
            SELECT SUM(mtd.mtd_jumlah)
            FROM tmintabarang_hdr mth
            JOIN tmintabarang_dtl mtd ON mtd.mtd_nomor = mth.mt_nomor
            WHERE mth.mt_closing = 'N' 
              AND mth.mt_cab = ? 
              AND mtd.mtd_kode = x.Kode 
              AND mtd.mtd_ukuran = x.Ukuran
              AND mth.mt_nomor NOT IN (SELECT sj_mt_nomor FROM tdc_sj_hdr WHERE sj_mt_nomor <> '')
          ), 0) AS sudahminta,

          /* stok DC */
          IFNULL((
            SELECT SUM(mst_stok_in - mst_stok_out) 
            FROM tmasterstok
            WHERE mst_aktif = 'Y' 
              AND mst_cab = ? 
              AND mst_brg_kode = x.Kode 
              AND mst_ukuran = x.Ukuran
          ), 0) AS Stok,

          /* SJ belum diterima */
          IFNULL((
            SELECT SUM(sjd.sjd_jumlah) 
            FROM tdc_sj_hdr sjh
            LEFT JOIN tdc_sj_dtl sjd ON sjd.sjd_nomor = sjh.sj_nomor
            WHERE sjh.sj_kecab = ? 
              AND sjh.sj_noterima = '' 
              AND sjh.sj_mt_nomor = ''
              AND sjd.sjd_kode = x.Kode 
              AND sjd.sjd_ukuran = x.Ukuran
          ), 0) AS sj

        FROM (
          SELECT
            a.brg_kode AS Kode,
            TRIM(CONCAT(a.brg_jeniskaos, ' ', a.brg_tipe, ' ', a.brg_lengan, ' ', a.brg_jeniskain, ' ', a.brg_warna)) AS Nama,
            b.brgd_ukuran AS Ukuran, 
            b.brgd_barcode AS Barcode,
            IFNULL(b.brgd_min, 0) AS StokMinimal, 
            IFNULL(b.brgd_max, 0) AS StokMaximal
          FROM tbarangdc a
          JOIN tbarangdc_dtl b ON b.brgd_kode = a.brg_kode
          WHERE a.brg_aktif = 0 
            AND a.brg_logstok = "Y" 
            AND b.brgd_min <> 0 
            AND a.brg_ktgp = "REGULER"
            ${categoryFilter}
        ) x
      ) y
      WHERE (y.StokMaximal - (y.Stok + y.sudahminta + y.sj)) > 0
      ORDER BY y.Nama, y.Ukuran;
    `;

    // Parameters: 1. sudahminta (cab), 2. stok (cab), 3. sj (cab)
    const [rows] = await connection.query(query, [cab, cab, cab]);

    const items = rows.map((r) => ({
      ...r,
      jumlah: r.mino,
    }));

    res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("Error getBufferStokItems:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

// 2. findByBarcode (Untuk scan manual di halaman Minta Barang)
const findByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const cabang = req.user.cabang;

    const query = `
      SELECT
        d.brgd_barcode AS barcode, d.brgd_kode AS kode,
        TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
        d.brgd_ukuran AS ukuran,
        IFNULL(d.brgd_min, 0) AS stokmin, IFNULL(d.brgd_max, 0) AS stokmax,
        -- STOK
        IFNULL((SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m WHERE m.mst_aktif='Y' AND m.mst_cab=? AND m.mst_brg_kode=d.brgd_kode AND m.mst_ukuran=d.brgd_ukuran), 0) AS stok,
        -- SUDAH MINTA
        IFNULL((SELECT SUM(mtd.mtd_jumlah) FROM tmintabarang_hdr hdr JOIN tmintabarang_dtl mtd ON mtd.mtd_nomor = hdr.mt_nomor WHERE hdr.mt_closing='N' AND hdr.mt_cab=? AND mtd.mtd_kode=d.brgd_kode AND mtd.mtd_ukuran=d.brgd_ukuran AND hdr.mt_nomor NOT IN (SELECT sj_mt_nomor FROM tdc_sj_hdr WHERE sj_mt_nomor <> "")), 0) AS sudahminta,
        -- SJ BELUM DITERIMA
        IFNULL((SELECT SUM(sjd.sjd_jumlah) FROM tdc_sj_hdr sjh JOIN tdc_sj_dtl sjd ON sjd.sjd_nomor = sjh.sj_nomor WHERE sjh.sj_kecab=? AND sjh.sj_noterima='' AND sjd.sjd_kode=d.brgd_kode AND sjd.sjd_ukuran=d.brgd_ukuran), 0) AS sj
      FROM tbarangdc_dtl d
      LEFT JOIN tbarangdc h ON h.brg_kode=d.brgd_kode
      WHERE h.brg_aktif=0 AND h.brg_logstok <> 'N' AND d.brgd_barcode = ?;
    `;

    const [rows] = await pool.query(query, [cabang, cabang, cabang, barcode]);
    if (!rows.length)
      return res
        .status(404)
        .json({ success: false, message: "Barcode tidak ditemukan." });

    const p = rows[0];
    const mino = p.stokmax - (p.stok + p.sudahminta + p.sj);
    p.mino = mino > 0 ? mino : 0;
    p.jumlah = 1; // Default jumlah jika scan manual

    res.status(200).json({ success: true, data: p });
  } catch (error) {
    console.error("Error findByBarcode:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// 3. Save Minta Barang
const save = async (req, res) => {
  const { header, items, isNew } = req.body;
  const user = req.user;
  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    let mtNomor = header.nomor;
    let idrec;

    // Generate Nomor Baru
    if (isNew) {
      const prefix = `${user.cabang}MT${format(
        new Date(header.tanggal),
        "yyMM"
      )}`;
      const [maxRows] = await connection.query(
        `SELECT IFNULL(MAX(RIGHT(mt_nomor, 4)), 0) as maxNum FROM tmintabarang_hdr WHERE LEFT(mt_nomor, 9) = ?`,
        [prefix]
      );
      const nextNum = parseInt(maxRows[0].maxNum, 10) + 1;
      mtNomor = `${prefix}${String(10000 + nextNum).slice(1)}`;
      idrec = `${user.cabang}MT${format(new Date(), "yyyyMMddHHmmssSSS")}`;

      await connection.query(
        `INSERT INTO tmintabarang_hdr (mt_idrec, mt_nomor, mt_tanggal, mt_so, mt_cus, mt_ket, mt_cab, user_create, date_create) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          idrec,
          mtNomor,
          header.tanggal,
          "",
          "",
          header.keterangan,
          user.cabang,
          user.kode,
        ]
      );
    }
    // (Logika update dihilangkan sementara karena di mobile biasanya hanya create baru)

    // Simpan Detail
    const validItems = items.filter((item) => (item.jumlah || 0) > 0);
    for (const item of validItems) {
      await connection.query(
        "INSERT INTO tmintabarang_dtl (mtd_idrec, mtd_nomor, mtd_kode, mtd_ukuran, mtd_jumlah) VALUES (?, ?, ?, ?, ?)",
        [idrec, mtNomor, item.kode, item.ukuran, item.jumlah]
      );
    }

    await connection.commit();
    res.status(201).json({
      success: true,
      message: `Permintaan ${mtNomor} berhasil disimpan.`,
      data: { nomor: mtNomor },
    });
  } catch (error) {
    await connection.rollback();
    console.error("Save Minta Barang Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal menyimpan Permintaan Barang." });
  } finally {
    connection.release();
  }
};

module.exports = { getBufferStokItems, findByBarcode, save };
