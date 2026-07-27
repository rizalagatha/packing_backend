const pool = require("../config/database");
const { format } = require("date-fns");

// GET /api/minta-bahan  (Browse)
const getAll = async (req, res) => {
  try {
    const { startDate, endDate, keyword } = req.query;

    const params = [startDate, endDate];

    let searchFilter = "";
    if (keyword) {
      searchFilter = " AND (h.min_nomor LIKE ? OR h.min_ket LIKE ?)";
      const searchPattern = `%${keyword}%`;
      params.push(searchPattern, searchPattern);
    }

    const query = `
      SELECT x.*, v.divisi AS Divisi FROM (
        SELECT 
          h.min_jenis AS Jenis, h.min_nomor AS Nomor, h.min_tanggal AS Tanggal, 
          DATE_FORMAT(h.date_create,"%H:%i:%s") AS Jam, h.min_cab AS Cab, 
          IF(h.min_gp="", p.pab_nama, RIGHT(g.gdgp_nama, LENGTH(g.gdgp_nama)-6)) AS GdgPeminta,
          IFNULL(s.spk_divisi, m.mspk_divisi) AS kddiv,
          h.min_spk_nomor AS SPK, IFNULL(s.spk_nama, m.Mspk_nama) AS NamaSpk, 
          IFNULL(s.spk_jumlah, 0) AS JmlSpk, h.min_ket AS Keterangan, 
          h.min_bagian AS Bagian, h.user_create AS Usr,
          IF(h.min_close=0, "OPEN", IF(h.min_close=1, "CLOSE", IF(h.min_close=9, "DICLOSE", "PROSES"))) AS Status,
          h.min_alasanclose AS AlasanClose,
          IFNULL((SELECT COUNT(*) FROM kencanaprint.tgarmenrealisasi_hdr q WHERE q.re_minta=h.min_nomor),0) AS totr,
          IFNULL((SELECT COUNT(*) FROM kencanaprint.tgarmenrealisasi_hdr q WHERE q.re_minta=h.min_nomor AND q.re_apv IS NOT NULL),0) AS tota,
          IFNULL((
            SELECT IFNULL(IF(pin_acc="" AND pin_dipakai="","WAIT",
                   IF(pin_acc="Y" AND pin_dipakai="","ACC",
                   IF(pin_acc="Y" AND pin_dipakai="Y","",
                   IF(pin_acc="N","TOLAK","")))),"")
            FROM kencanaprint.tspk_pin5 WHERE pin_trs="PERMINTAAN GARMEN" AND pin_nomor=h.min_nomor ORDER BY pin_urut DESC LIMIT 1
          ),"") AS Ngedit
        FROM kencanaprint.tgarmenminta_hdr h
        LEFT JOIN kencanaprint.tgudangproduksi g ON g.gdgp_kode = h.min_gp
        LEFT JOIN kencanaprint.tspk s ON s.spk_nomor = h.min_spk_nomor
        LEFT JOIN kencanaprint.tmemospk m ON m.mspk_nomor = h.min_spk_nomor
        LEFT JOIN kencanaprint.tpabrik p ON p.pab_kode = h.min_cab
        WHERE h.min_tanggal >= ? AND h.min_tanggal <= ? 
          AND h.min_jenis IN ('OBAT', 'ACCESORIES')
          AND h.min_cab = 'P03'
          ${searchFilter}
      ) x 
      LEFT JOIN kencanaprint.tdivisi v ON v.kode = x.kddiv
      ORDER BY x.Nomor DESC
    `;

    const [rows] = await pool.query(query, params);

    const data = rows.map((row) => ({
      ...row,
      Approve: row.totr === 0 ? "" : row.tota < row.totr ? "N" : "Y",
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error getAll mintaBahan:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/minta-bahan/:nomor/details  (Expand Row)
const getDetails = async (req, res) => {
  try {
    const { nomor } = req.params;

    // 1. Realisasi Header
    const [realisasiRows] = await pool.query(
      `
      SELECT 
        h.re_minta AS NomorMinta, h.re_nomor AS NoRealisasi, h.re_tanggal AS TglRealisasi, 
        IF(h.re_apv IS NULL, "", DATE_FORMAT(h.re_apv, "%d-%m-%Y %H:%i:%s")) AS Approve, 
        SUM(d.red_jumlah) AS Jumlah, h.re_keterangan AS Keterangan
      FROM kencanaprint.tgarmenrealisasi_hdr h
      INNER JOIN kencanaprint.tgarmenrealisasi_dtl d ON d.red_nomor = h.re_nomor
      WHERE h.re_minta = ?
      GROUP BY h.re_nomor
      ORDER BY h.re_nomor ASC
      `,
      [nomor],
    );

    // 2. Detail Barang Permintaan
    const [itemsRows] = await pool.query(
      `
      SELECT 
        d.mind_brg_kode AS Kode,
        IF(b.brg_note="", b.brg_nama, CONCAT(b.brg_nama," - ",b.brg_note)) AS Nama,
        b.brg_satuan    AS Satuan,
        b.brg_note      AS Note,
        d.mind_jumlah   AS Jumlah,
        d.mind_ket      AS Keterangan,
        IFNULL((
          SELECT SUM(i.red_jumlah) 
          FROM kencanaprint.tgarmenrealisasi_dtl i 
          INNER JOIN kencanaprint.tgarmenrealisasi_hdr j ON j.re_nomor = i.red_nomor 
          WHERE j.re_minta = d.mind_nomor AND i.red_brg_kode = d.mind_brg_kode
        ), 0) AS Realisasi
      FROM kencanaprint.tgarmenminta_dtl d
      LEFT JOIN kencanaprint.tgarmen_brg b ON b.brg_kode = d.mind_brg_kode
      WHERE d.mind_nomor = ?
      ORDER BY d.mind_urut ASC
      `,
      [nomor],
    );

    // 3. Rincian Item per Realisasi
    const [realisasiDetailsRows] = await pool.query(
      `
      SELECT 
        h.re_minta     AS NomorMinta,
        d.red_nomor    AS NomorRealisasi,
        d.red_brg_kode AS Kode,
        IF(b.brg_note="", b.brg_nama, CONCAT(b.brg_nama," - ",b.brg_note)) AS Nama,
        b.brg_satuan   AS Satuan,
        d.red_jumlah   AS Jumlah
      FROM kencanaprint.tgarmenrealisasi_dtl d
      INNER JOIN kencanaprint.tgarmenrealisasi_hdr h ON h.re_nomor = d.red_nomor
      LEFT JOIN kencanaprint.tgarmen_brg b ON b.brg_kode = d.red_brg_kode
      WHERE h.re_minta = ?
      ORDER BY d.red_nomor ASC, d.red_brg_kode ASC
      `,
      [nomor],
    );

    const formattedRealisasi = realisasiRows.map((r) => ({
      ...r,
      TglRealisasi: r.TglRealisasi
        ? format(new Date(r.TglRealisasi), "dd/MM/yyyy")
        : "",
    }));

    res.status(200).json({
      success: true,
      data: {
        realisasi: formattedRealisasi,
        items: itemsRows,
        realisasiDetails: realisasiDetailsRows,
      },
    });
  } catch (error) {
    console.error("Error getDetails mintaBahan:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/minta-bahan/check-unapproved  (badge notifikasi di browse)
// Cabang P03 tetap dapat notifikasi ini (untuk kesadaran), meski di web
// P03 punya bypass supaya tidak diblokir bikin form permintaan baru —
// pemblokiran form itu logikanya nanti dipasang di endpoint form input, bukan di sini.
const checkUnapproved = async (req, res) => {
  try {
    const user = req.user;

    const query = `
      SELECT IFNULL(COUNT(*), 0) AS blmApv
      FROM kencanaprint.tgarmenrealisasi_hdr h
      INNER JOIN kencanaprint.tgarmenminta_hdr a ON a.min_nomor = h.re_minta AND a.user_create = ?
      WHERE h.re_minta LIKE 'MIA%' AND h.re_apv IS NULL AND h.re_tanggal < DATE_ADD(CURDATE(), INTERVAL -1 DAY)
    `;
    const [rows] = await pool.query(query, [user.kode]);

    res.status(200).json({ success: true, data: { count: rows[0].blmApv } });
  } catch (error) {
    console.error("Error checkUnapproved mintaBahan:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/minta-bahan/realisasi/:noRealisasi/approve
const approveRealisasi = async (req, res) => {
  const { noRealisasi } = req.params;
  const user = req.user;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const qCek = `
      SELECT h.re_apv, h.re_tanggal, m.min_jenis
      FROM kencanaprint.tgarmenrealisasi_hdr h
      INNER JOIN kencanaprint.tgarmenminta_hdr m ON m.min_nomor = h.re_minta
      WHERE h.re_nomor = ?
    `;
    const [cekRows] = await conn.query(qCek, [noRealisasi]);
    if (cekRows.length === 0) {
      throw new Error("Data realisasi tidak ditemukan.");
    }

    const data = cekRows[0];
    const sudahApprove =
      data.re_apv !== null &&
      data.re_apv !== "0000-00-00" &&
      data.re_apv !== "";
    if (sudahApprove) {
      throw new Error("Realisasi ini sudah diapprove sebelumnya.");
    }

    // 1. Update timestamp approve
    const waktuApprove = format(new Date(), "yyyy-MM-dd HH:mm:ss");
    await conn.query(
      `UPDATE kencanaprint.tgarmenrealisasi_hdr SET re_apv = ? WHERE re_nomor = ?`,
      [waktuApprove, noRealisasi],
    );

    // 2. Insert/Update stok (hanya untuk ACCESORIES dan OBAT)
    if (["ACCESORIES", "OBAT"].includes(data.min_jenis)) {
      const [detailRows] = await conn.query(
        `SELECT red_brg_kode AS brg_kode, red_jumlah AS jumlah
         FROM kencanaprint.tgarmenrealisasi_dtl
         WHERE red_nomor = ?`,
        [noRealisasi],
      );

      if (!detailRows.length) {
        throw new Error("Detail item realisasi kosong.");
      }

      const tglStok = data.re_tanggal
        ? format(new Date(data.re_tanggal), "yyyy-MM-dd")
        : format(new Date(), "yyyy-MM-dd");

      for (const item of detailRows) {
        await conn.query(
          `INSERT INTO tmasterstok_bahan
            (mst_noreferensi, mst_brg_kode, mst_tanggal,
             mst_stok_in, mst_stok_out, mst_cab, mst_jenis,
             mst_ket, mst_user, mst_tgl_input)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             mst_stok_in = mst_stok_in + VALUES(mst_stok_in)`,
          [
            noRealisasi,
            item.brg_kode,
            tglStok,
            item.jumlah,
            user.cabang,
            data.min_jenis,
            `Realisasi ${noRealisasi}`,
            user.kode || "SYSTEM",
          ],
        );
      }
    }

    await conn.commit();
    res.status(200).json({ success: true, message: "Approve berhasil." });
  } catch (error) {
    await conn.rollback();
    const isValidationError = [
      "sudah diapprove",
      "tidak ditemukan",
      "kosong",
    ].some((msg) => error.message.toLowerCase().includes(msg));
    res
      .status(isValidationError ? 400 : 500)
      .json({ success: false, message: error.message });
  } finally {
    conn.release();
  }
};

module.exports = {
  getAll,
  getDetails,
  checkUnapproved,
  approveRealisasi,
};
