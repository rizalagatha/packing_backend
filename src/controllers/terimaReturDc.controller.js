const pool = require("../config/database");

// --- Helper: Generate Nomor Dokumen Terima (KDC.RB.YYMM.XXXX) ---
const generateNomorTerima = async (connection, tanggal) => {
  const yearMonth = new Date(tanggal)
    .toISOString()
    .slice(2, 7)
    .replace("-", "");
  const prefix = `KDC.RB.${yearMonth}.`; // Hasil: KDC.RB.2602.

  // Gunakan LIKE supaya lebih fleksibel nyarinya
  const query = `
    SELECT IFNULL(MAX(CAST(RIGHT(rb_nomor, 4) AS UNSIGNED)), 0) + 1 AS next_num 
    FROM tdcrb_hdr 
    WHERE rb_nomor LIKE ?
  `;

  const [rows] = await connection.query(query, [`${prefix}%`]);
  const nextNum = rows[0].next_num.toString().padStart(4, "0");

  return `${prefix}${nextNum}`;
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

// --- 1. Fungsi Simpan Pending ---
const savePending = async (req, res) => {
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const { header, items } = req.body;
    const user = req.user;

    // Hapus pending lama untuk nomor ini
    await connection.query(
      "DELETE FROM tdcrb_dtl_pending WHERE rbp_nomor_asal = ?",
      [header.nomorRb],
    );

    // Masukkan progres scan terbaru
    const pendingValues = items
      .filter((it) => it.jumlahTerima > 0) // Hanya simpan yang sudah di-scan
      .map((it) => [
        header.nomorRb,
        it.kode,
        it.ukuran,
        it.jumlahTerima,
        user.kode,
      ]);

    if (pendingValues.length > 0) {
      await connection.query(
        "INSERT INTO tdcrb_dtl_pending (rbp_nomor_asal, rbp_kode, rbp_ukuran, rbp_jumlah, user_create) VALUES ?",
        [pendingValues],
      );
    }

    await connection.commit();
    res.json({
      success: true,
      message: "Progres scan berhasil disimpan (Pending).",
    });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

// 2. Muat Detail Item dari Dokumen Retur Store
const loadDetail = async (req, res) => {
  try {
    const { nomorRb } = req.params;

    // Gabungkan data KIRIM (trbdc_dtl) dengan data PENDING (tdcrb_dtl_pending) di SQL
    const query = `
      SELECT 
        d.rbd_kode AS kode, 
        b.brgd_barcode AS barcode, 
        d.rbd_ukuran AS ukuran, 
        d.rbd_jumlah AS jumlahKirim,
        IFNULL(p.rbp_jumlah, 0) AS jumlahTerima, -- AMBIL DATA PENDING DI SINI
        TRIM(CONCAT_WS(" ", 
          a.brg_jeniskaos, 
          a.brg_tipe, 
          a.brg_lengan, 
          a.brg_jeniskain, 
          a.brg_warna
        )) AS nama
      FROM trbdc_dtl d
      LEFT JOIN tdcrb_dtl_pending p ON 
        p.rbp_nomor_asal = d.rbd_nomor AND 
        p.rbp_kode = d.rbd_kode AND 
        p.rbp_ukuran = d.rbd_ukuran
      LEFT JOIN tbarangdc a ON a.brg_kode = d.rbd_kode
      LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.rbd_kode AND b.brgd_ukuran = d.rbd_ukuran
      WHERE d.rbd_nomor = ?
    `;

    const [rows] = await pool.query(query, [nomorRb]);
    if (rows.length === 0)
      return res.status(404).json({ message: "Data tidak ditemukan" });

    // Ambil Header
    const [headerRows] = await pool.query(
      "SELECT rb_nomor, rb_tanggal, rb_ket, g.gdg_nama FROM trbdc_hdr h LEFT JOIN tgudang g ON g.gdg_kode = LEFT(h.rb_nomor, 3) WHERE rb_nomor = ?",
      [nomorRb],
    );

    res.json({
      success: true,
      data: {
        header: {
          nomorRb: headerRows[0].rb_nomor,
          tanggalRb: headerRows[0].rb_tanggal,
          gudangAsalNama: headerRows[0].gdg_nama,
          keterangan: headerRows[0].rb_ket,
        },
        items: rows, // 'rows' sudah mengandung 'jumlahTerima' dari SQL
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 3. Simpan Penerimaan Final (Update Stok DC + Auto Koreksi)
const saveTerima = async (req, res) => {
  let retries = 3;

  while (retries > 0) {
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      const { header, items } = req.body;
      const user = req.user;

      console.log("--- PROSES SIMPAN FINAL RETUR ---");
      console.log("Nomor RB Asal:", header.nomorRb);

      if (!items || items.length === 0) {
        throw new Error("Tidak ada item yang diterima.");
      }

      // 1. Inisialisasi selisihItems (WAJIB ADA BIAR GAK ERROR)
      const selisihItems = [];

      // 2. Generate Nomor Terima
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

      // 5. BULK INSERT DETAIL (tdcrb_dtl)
      const valuesForInsert = items.map((it, index) => {
        const urutan = String(index + 1).padStart(3, "0");

        // rbd_iddrec (Contoh: KDC.RB.2602.0001.001) -> Total 20 karakter, aman di VARCHAR(30)
        const iddrec = `${nomorTerima}.${urutan}`;

        if (Number(it.jumlahTerima) !== Number(it.jumlahKirim)) {
          selisihItems.push(it);
        }

        return [
          iddrec, // Kolom 1: rbd_iddrec
          nomorTerima, // Kolom 2: rbd_nomor
          it.kode, // Kolom 3: rbd_kode
          it.ukuran, // Kolom 4: rbd_ukuran
          Number(it.jumlahTerima), // Kolom 5: rbd_jumlah
        ];
      });

      // 2. Eksekusi Bulk Insert
      const sqlInsertDetail = `
      INSERT INTO tdcrb_dtl 
      (rbd_iddrec, rbd_nomor, rbd_kode, rbd_ukuran, rbd_jumlah) 
      VALUES ?
    `;

      await connection.query(sqlInsertDetail, [valuesForInsert]);

      // 6. AUTO-KOREKSI (Hanya jika ada selisih)
      if (selisihItems.length > 0) {
        const nomorKoreksi = await generateNomorKoreksi(
          connection,
          user.cabang,
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
          Number(s.jumlahKirim), // kord_stok (jumlah yang seharusnya)
          Number(s.jumlahTerima), // kord_jumlah (jumlah fisik diterima)
          Number(s.jumlahTerima) - Number(s.jumlahKirim), // kord_selisih
          "Selisih Terima Retur",
        ]);

        const sqlInsertKoreksi = `
        INSERT INTO tkor_dtl 
        (kord_kor_nomor, kord_kode, kord_ukuran, kord_stok, kord_jumlah, kord_selisih, kord_ket) 
        VALUES ?
      `;

        await connection.query(sqlInsertKoreksi, [koreksiValues]);

        // Update referensi koreksi di header
        await connection.query(
          "UPDATE tdcrb_hdr SET rb_koreksi = ? WHERE rb_nomor = ?",
          [nomorKoreksi, nomorTerima],
        );
      }

      await connection.query(
        "DELETE FROM tdcrb_dtl_pending WHERE rbp_nomor_asal = ?",
        [header.nomorRb],
      );

      await connection.commit();
      return res.json({
        success: true,
        message: `Berhasil disimpan: ${nomorTerima}`,
      });
    } catch (error) {
      await connection.rollback();

      // Jika errornya duplikat nomor, coba lagi
      if (error.code === "ER_DUP_ENTRY" && retries > 1) {
        console.log(
          `⚠️ Nomor bentrok, mencoba ulang... sisa jatah: ${retries - 1}`,
        );
        retries--;
        connection.release(); // Lepas koneksi sebelum loop ulang
        continue;
      }

      console.error("❌ ERROR SIMPAN RETUR:", error);
      res.status(500).json({ success: false, message: error.message });
      retries = 0; // Hentikan loop
    } finally {
      if (!connection._fatalError) connection.release();
    }
  }
};

module.exports = { searchRetur, loadDetail, saveTerima, savePending };
