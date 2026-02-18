const pool = require("../config/database");

// --- Helper: Generate Nomor Dokumen Terima (KDC.RB.YYMM.XXXX) ---
const generateNomorTerima = async (connection, tanggal) => {
  const yearMonth = new Date(tanggal)
    .toISOString()
    .slice(2, 7)
    .replace("-", "");
  const prefix = `KDC.RB.${yearMonth}.`;
  const [rows] = await connection.query(
    "SELECT IFNULL(MAX(RIGHT(rb_nomor, 4)), 0) + 1 AS next_num FROM tdcrb_hdr WHERE LEFT(rb_nomor, 11) = ?",
    [prefix],
  );
  return `${prefix}${rows[0].next_num.toString().padStart(4, "0")}`;
};

// --- Helper: Generate Nomor Koreksi (KDC.KOR.YYMM.XXXX) ---
const generateNomorKoreksi = async (connection, tanggal) => {
  const yearMonth = new Date(tanggal)
    .toISOString()
    .slice(2, 7)
    .replace("-", "");
  const prefix = `KDC.KOR.${yearMonth}.`;
  const [rows] = await connection.query(
    "SELECT IFNULL(MAX(RIGHT(kor_nomor, 4)), 0) + 1 AS next_num FROM tkor_hdr WHERE LEFT(kor_nomor, 12) = ?",
    [prefix],
  );
  return `${prefix}${rows[0].next_num.toString().padStart(4, "0")}`;
};

// 1. Cari Daftar Retur dari Store yang belum diterima DC
const searchRetur = async (req, res) => {
  try {
    const { term = "" } = req.query;
    const query = `
      SELECT 
        h.rb_nomor as nomor, 
        h.rb_tanggal as tanggal, 
        g.gdg_nama as gudang_asal,
        h.rb_noterima -- Kita ambil untuk pengecekan log
      FROM trbdc_hdr h
      LEFT JOIN tgudang g ON g.gdg_kode = LEFT(h.rb_nomor, 3)
      WHERE 
        -- FIX: Cek NULL atau string kosong
        (h.rb_noterima IS NULL OR h.rb_noterima = '') 
        AND (h.rb_nomor LIKE ? OR g.gdg_nama LIKE ?)
      ORDER BY h.rb_tanggal DESC 
      LIMIT 50
    `;

    const [rows] = await pool.query(query, [`%${term}%`, `%${term}%`]);

    // Log untuk debug di console terminal backend
    console.log(
      `[DEBUG] Found ${rows.length} pending returns for term: "${term}"`,
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[ERROR] searchRetur:", error);
    res.status(500).json({ message: error.message });
  }
};

// 2. Muat Detail Item dari Dokumen Retur Store
const loadDetail = async (req, res) => {
  try {
    const { nomorRb } = req.params;
    const query = `
      SELECT 
        h.rb_nomor, h.rb_tanggal, h.rb_ket,
        LEFT(h.rb_nomor, 3) AS gudangAsalKode,
        g.gdg_nama AS gudangAsalNama,
        d.rbd_kode AS kode,
        b.brgd_barcode AS barcode,
        TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama,
        d.rbd_ukuran AS ukuran,
        d.rbd_jumlah AS jumlahKirim
      FROM trbdc_hdr h
      INNER JOIN trbdc_dtl d ON d.rbd_nomor = h.rb_nomor
      LEFT JOIN tbarangdc a ON a.brg_kode = d.rbd_kode
      LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.rbd_kode AND b.brgd_ukuran = d.rbd_ukuran
      LEFT JOIN tgudang g ON g.gdg_kode = LEFT(h.rb_nomor, 3)
      WHERE h.rb_nomor = ?
    `;
    const [rows] = await pool.query(query, [nomorRb]);
    if (rows.length === 0)
      return res.status(404).json({ message: "Data tidak ditemukan" });

    const header = {
      nomorRb: rows[0].rb_nomor,
      tanggalRb: rows[0].rb_tanggal,
      gudangAsalKode: rows[0].gudangAsalKode,
      gudangAsalNama: rows[0].gudangAsalNama,
      keterangan: rows[0].rb_ket,
    };
    const items = rows.map((r) => ({
      kode: r.kode,
      barcode: r.barcode,
      nama: r.nama,
      ukuran: r.ukuran,
      jumlahKirim: r.jumlahKirim,
    }));

    res.json({ success: true, data: { header, items } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 3. Simpan Penerimaan Final (Update Stok DC + Auto Koreksi)
const saveTerima = async (req, res) => {
  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    const { header, items } = req.body;
    const user = req.user;

    // 1. LOG UNTUK DEBUG (Cek di terminal CMD/Nodemon)
    console.log("--- PROSES SIMPAN FINAL RETUR ---");
    console.log("Nomor RB Asal:", header.nomorRb);
    console.log("Jumlah Item:", items.length);

    if (!items || items.length === 0) {
      throw new Error("Tidak ada item yang diterima.");
    }

    // 2. Generate Nomor Terima (KDC.RB...)
    const nomorTerima = await generateNomorTerima(connection, header.tanggal);

    // 3. Simpan Header (tdcrb_hdr)
    await connection.query(
      "INSERT INTO tdcrb_hdr (rb_nomor, rb_tanggal, user_create, date_create) VALUES (?, ?, ?, NOW())",
      [nomorTerima, header.tanggal, user.kode],
    );

    // 4. Update status di Dokumen Asal (trbdc_hdr)
    await connection.query(
      "UPDATE trbdc_hdr SET rb_noterima = ? WHERE rb_nomor = ?",
      [nomorTerima, header.nomorRb],
    );

    // 5. BULK INSERT DETAIL (tdcrb_dtl) -
    // Teknik ini jauh lebih cepat daripada looping query satu-satu
    const selisihItems = [];
    const valuesForInsert = items.map((it, index) => {
      // Buat ID detail yang unik (Contoh: KDC.RB.2602.0001.001)
      const iddrec = `${nomorTerima}.${String(index + 1).padStart(3, "0")}`;

      // Catat selisih untuk auto-koreksi nanti
      if (Number(it.jumlahTerima) !== Number(it.jumlahKirim)) {
        selisihItems.push(it);
      }

      return [
        iddrec, // rbd_iddrec
        nomorTerima, // rbd_nomor
        it.kode, // rbd_kode
        it.ukuran, // rbd_ukuran
        it.jumlahTerima, // rbd_jumlah
      ];
    });

    await connection.query(
      "INSERT INTO tdcrb_dtl (rbd_iddrec, rbd_nomor, rbd_kode, rbd_ukuran, rbd_jumlah) VALUES ?",
      [valuesForInsert], // Data dikirim sebagai array of array
    );

    // 6. AUTO-KOREKSI (Hanya jika ada selisih)
    if (selisihItems.length > 0) {
      const nomorKoreksi = await generateNomorKoreksi(
        connection,
        header.tanggal,
      );
      await connection.query(
        "INSERT INTO tkor_hdr (kor_nomor, kor_tanggal, kor_ket, user_create, date_create) VALUES (?, ?, ?, ?, NOW())",
        [
          nomorKoreksi,
          header.tanggal,
          `AUTO-KOR TERIMA RETUR ${nomorTerima}`,
          user.kode,
        ],
      );

      const koreksiValues = selisihItems.map((s) => [
        nomorKoreksi,
        s.kode,
        s.ukuran,
        s.jumlahKirim,
        s.jumlahTerima,
        Number(s.jumlahTerima) - Number(s.jumlahKirim),
        "Selisih Terima Retur",
      ]);

      await connection.query(
        "INSERT INTO tkor_dtl (kord_kor_nomor, kord_kode, kord_ukuran, kord_stok, kord_jumlah, kord_selisih, kord_ket) VALUES ?",
        [koreksiValues],
      );

      await connection.query(
        "UPDATE tdcrb_hdr SET rb_koreksi = ? WHERE rb_nomor = ?",
        [nomorKoreksi, nomorTerima],
      );
    }

    await connection.commit();
    console.log("✅ SIMPAN BERHASIL:", nomorTerima);
    res.json({
      success: true,
      message: `Berhasil disimpan dengan nomor: ${nomorTerima}`,
    });
  } catch (error) {
    await connection.rollback();
    console.error("❌ ERROR SIMPAN RETUR:", error.message); //
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

module.exports = { searchRetur, loadDetail, saveTerima };
