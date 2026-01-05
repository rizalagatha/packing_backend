const pool = require("../config/database");

/**
 * Helper: Generate Nomor Packing List Baru
 * Format: KDC.PL.YYMM.XXXX (Misal: KDC.PL.2512.0001)
 */
const generateNewPlNumber = async (gudang, tanggal) => {
  // Ambil YYMM dari tanggal (YYYY-MM-DD)
  const dateObj = new Date(tanggal);
  const year = dateObj.getFullYear().toString().substring(2); // 25
  const month = (dateObj.getMonth() + 1).toString().padStart(2, "0"); // 12

  const prefix = `${gudang}.PL.${year}${month}.`;

  const query = `
    SELECT IFNULL(MAX(RIGHT(pl_nomor, 4)), 0) + 1 AS next_num
    FROM tpacking_list_hdr 
    WHERE pl_nomor LIKE ?;
  `;

  const [rows] = await pool.query(query, [`${prefix}%`]);
  const nextNumber = rows[0].next_num.toString().padStart(4, "0");

  return `${prefix}${nextNumber}`;
};

/**
 * 1. Simpan Packing List (Create / Update)
 */
const savePackingList = async (req, res) => {
  const { header, items, isNew } = req.body;
  const user = req.user; // Dari middleware auth

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    if (!header.store?.kode) throw new Error("Store tujuan harus diisi.");
    if (!items || items.length === 0)
      throw new Error("Detail barang harus diisi.");

    let plNomor = header.nomor;

    // --- HANDLE HEADER ---
    if (isNew) {
      // Generate Nomor Baru
      plNomor = await generateNewPlNumber("KDC", header.tanggal); // Default Gudang KDC

      const insertSql = `
        INSERT INTO tpacking_list_hdr 
        (pl_nomor, pl_tanggal, pl_cab_tujuan, pl_mt_nomor, pl_ket, pl_status, user_create, date_create)
        VALUES (?, ?, ?, ?, ?, 'O', ?, NOW())
      `;
      await connection.query(insertSql, [
        plNomor,
        header.tanggal,
        header.store.kode,
        header.permintaan || null,
        header.keterangan,
        user.kode, // User login
      ]);
    } else {
      // Mode Edit: Cek status dulu
      const [cek] = await connection.query(
        "SELECT pl_status FROM tpacking_list_hdr WHERE pl_nomor = ?",
        [plNomor]
      );

      if (cek.length === 0) throw new Error("Data tidak ditemukan.");
      if (cek[0].pl_status === "C") {
        throw new Error(
          "Packing List sudah Closed (Jadi SJ). Tidak bisa diedit."
        );
      }

      const updateSql = `
        UPDATE tpacking_list_hdr 
        SET pl_tanggal = ?, pl_cab_tujuan = ?, pl_mt_nomor = ?, pl_ket = ?, user_modified = ?, date_modified = NOW()
        WHERE pl_nomor = ?
      `;
      await connection.query(updateSql, [
        header.tanggal,
        header.store.kode,
        header.permintaan || null,
        header.keterangan,
        user.kode,
        plNomor,
      ]);
    }

    // --- HANDLE DETAIL ---
    // Hapus detail lama (cara paling aman untuk update)
    await connection.query(
      "DELETE FROM tpacking_list_dtl WHERE pld_nomor = ?",
      [plNomor]
    );

    // Insert detail baru
    if (items.length > 0) {
      // Filter item valid (jumlah > 0)
      const validItems = items.filter((item) => item.kode && item.jumlah > 0);

      if (validItems.length > 0) {
        const values = validItems.map((item) => [
          plNomor,
          item.kode,
          item.ukuran,
          item.jumlah,
          item.keterangan || "",
        ]);

        const insertDtlSql = `
          INSERT INTO tpacking_list_dtl (pld_nomor, pld_kode, pld_ukuran, pld_jumlah, pld_keterangan) 
          VALUES ?
        `;
        await connection.query(insertDtlSql, [values]);
      }
    }

    // --- [TAMBAHAN] UPDATE STATUS MINTA BARANG ---
    if (header.permintaan) {
      await connection.query(
        `UPDATE tmintabarang_hdr 
         SET mt_close = 'Y', user_modified = ?, date_modified = NOW() 
         WHERE mt_nomor = ?`,
        [user.kode, header.permintaan]
      );
    }

    await connection.commit();

    res.json({
      message: `Packing List ${plNomor} berhasil disimpan.`,
      nomor: plNomor,
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error savePackingList:", error);
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

/**
 * 2. Load Detail Packing List (Untuk Mode Edit)
 */
const getPackingListDetail = async (req, res) => {
  const { nomor } = req.params;

  try {
    // Ambil Header
    const headerQuery = `
      SELECT 
        h.pl_nomor AS nomor,
        h.pl_tanggal AS tanggal,
        h.pl_cab_tujuan AS store_kode,
        g.gdg_nama AS store_nama,
        h.pl_mt_nomor AS permintaan,
        h.pl_ket AS keterangan,
        h.pl_status AS status
      FROM tpacking_list_hdr h
      LEFT JOIN tgudang g ON g.gdg_kode = h.pl_cab_tujuan
      WHERE h.pl_nomor = ?
    `;
    const [headers] = await pool.query(headerQuery, [nomor]);

    if (headers.length === 0) {
      return res.status(404).json({ message: "Data tidak ditemukan." });
    }

    // Ambil Items + Stok KDC
    const itemsQuery = `
      SELECT 
        d.pld_kode AS kode,
        TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama,
        d.pld_ukuran AS ukuran,
        d.pld_jumlah AS jumlah,
        d.pld_keterangan AS keterangan,
        b.brgd_barcode AS barcode,
        
        -- Hitung Stok KDC (Pusat)
        IFNULL((
           SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m 
           WHERE m.mst_aktif='Y' AND m.mst_cab='KDC' 
             AND m.mst_brg_kode=d.pld_kode AND m.mst_ukuran=d.pld_ukuran
        ), 0) AS stok

      FROM tpacking_list_dtl d
      LEFT JOIN tbarangdc a ON a.brg_kode = d.pld_kode
      LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.pld_kode AND b.brgd_ukuran = d.pld_ukuran
      WHERE d.pld_nomor = ?
      ORDER BY d.pld_kode, d.pld_ukuran
    `;
    const [items] = await pool.query(itemsQuery, [nomor]);

    res.json({
      header: headers[0],
      items: items,
    });
  } catch (error) {
    console.error("Error getPackingListDetail:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * 3. Load Items dari Permintaan (tmintabarang_dtl)
 * Mengambil detail barang berdasarkan Nomor Permintaan
 */
const loadItemsFromRequest = async (req, res) => {
  const { nomor } = req.query; // Mengambil ?nomor=...

  console.log(`[API] Loading items for Permintaan: ${nomor}`);

  try {
    const query = `
      SELECT 
        d.mtd_kode AS kode,
        TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS nama,
        d.mtd_ukuran AS ukuran,
        d.mtd_jumlah AS minta,
        
        -- Ambil Barcode
        b.brgd_barcode AS barcode,
        
        -- Hitung Stok DC (KDC) saat ini untuk referensi
        IFNULL((
           SELECT SUM(m.mst_stok_in - m.mst_stok_out) 
           FROM tmasterstok m 
           WHERE m.mst_aktif='Y' 
             AND m.mst_cab='KDC' 
             AND m.mst_brg_kode=d.mtd_kode 
             AND m.mst_ukuran=d.mtd_ukuran
        ), 0) AS stok

      FROM tmintabarang_dtl d
      LEFT JOIN tbarangdc a ON a.brg_kode = d.mtd_kode
      LEFT JOIN tbarangdc_dtl b ON b.brgd_kode = d.mtd_kode AND b.brgd_ukuran = d.mtd_ukuran
      WHERE d.mtd_nomor = ?
      ORDER BY d.mtd_kode, d.mtd_ukuran
    `;

    const [rows] = await pool.query(query, [nomor]);

    console.log(`[API] Found ${rows.length} items.`);

    // Kembalikan array data ke frontend
    res.json(rows);
  } catch (error) {
    console.error("Error loadItemsFromRequest:", error);
    res
      .status(500)
      .json({ message: "Terjadi kesalahan saat memuat item permintaan." });
  }
};

/**
 * 4. Cari Barang via Barcode (Scan Manual)
 */
const findProductByBarcode = async (req, res) => {
  const { barcode } = req.params;

  try {
    const query = `
      SELECT 
        d.brgd_kode AS kode,
        TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
        d.brgd_ukuran AS ukuran,
        d.brgd_barcode AS barcode,
        
        -- Stok KDC
        IFNULL((
           SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m 
           WHERE m.mst_aktif='Y' AND m.mst_cab='KDC' 
             AND m.mst_brg_kode=d.brgd_kode AND m.mst_ukuran=d.brgd_ukuran
        ), 0) AS stok

      FROM tbarangdc_dtl d
      LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
      WHERE h.brg_aktif = 0 
        AND d.brgd_barcode = ?
    `;

    const [rows] = await pool.query(query, [barcode]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Barcode tidak ditemukan." });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Error findProductByBarcode:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * 5. Lookup Permintaan Open (Search Modal)
 * REVISI: Disamakan logikanya dengan SuratJalanScreen (Cek tdc_sj_hdr)
 */
const searchPermintaanOpen = async (req, res) => {
  const { term = "", page = 1, storeKode } = req.query;

  // Debugging: Cek apa yang diterima backend
  console.log("[API] Search Permintaan:", { term, page, storeKode });

  try {
    if (!storeKode) {
      return res.json([]);
    }

    const itemsPerPage = 20;
    const offset = (page - 1) * itemsPerPage;
    const searchTerm = `%${term}%`;

    const params = [
      storeKode, // 1. LEFT(mt_nomor, 3)
      searchTerm, // 2. LIKE mt_nomor
      searchTerm, // 3. LIKE mt_tanggal
      searchTerm, // 4. LIKE mt_otomatis
      searchTerm, // 5. LIKE mt_ket
      itemsPerPage, // 6. LIMIT
      offset, // 7. OFFSET
    ];

    const query = `
        SELECT 
            h.mt_nomor AS nomor, 
            h.mt_tanggal AS tanggal, 
            h.mt_otomatis AS otomatis, 
            h.mt_ket AS keterangan
        FROM tmintabarang_hdr h
        WHERE 
            -- 1. Filter Store (Wajib sama 3 digit awal)
            LEFT(h.mt_nomor, 3) = ? 
            
            -- 2. Pastikan Status Close = N (Belum ditutup manual)
            AND h.mt_close = 'N'

            -- 3. VALIDASI: Belum jadi Surat Jalan (Sesuai Referensi Lama)
            -- (Kita gunakan logika Surat Jalan agar data muncul dulu)
            AND h.mt_nomor NOT IN (SELECT sj_mt_nomor FROM tdc_sj_hdr WHERE sj_mt_nomor <> "")
            
            -- 4. Pencarian Text
            AND (
                h.mt_nomor LIKE ? 
                OR h.mt_tanggal LIKE ? 
                OR h.mt_otomatis LIKE ? 
                OR h.mt_ket LIKE ?
            )
        ORDER BY h.date_create DESC
        LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(query, params);

    console.log(`[API] Found ${rows.length} permintaan for store ${storeKode}`);
    res.json(rows);
  } catch (error) {
    console.error("Error searchPermintaanOpen:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * 6. Ambil Riwayat Packing List
 * Filter: StartDate, EndDate
 */
const getHistory = async (req, res) => {
  const { startDate, endDate } = req.query;
  const user = req.user; // Jika ingin filter per cabang user

  try {
    // Query digabung dengan detail untuk hitung total item & qty
    const query = `
        SELECT 
            h.pl_nomor AS Nomor,
            h.pl_tanggal AS Tanggal,
            h.pl_cab_tujuan AS Store,
            g.gdg_nama AS Nama_Store,
            h.pl_mt_nomor AS NoMinta,
            
            -- Logika Status
            CASE 
                WHEN h.pl_status = 'O' THEN 'OPEN'
                -- Jika Closed tapi belum ada No Terima di SJ (atau SJ belum dibuat), anggap SENT
                WHEN h.pl_status = 'C' AND (sj.sj_noterima IS NULL OR sj.sj_noterima = '') THEN 'SENT'
                -- Jika Closed dan sudah ada No Terima
                WHEN h.pl_status = 'C' AND sj.sj_noterima <> '' THEN 'RECEIVED'
                ELSE h.pl_status 
            END AS Status,

            IFNULL(sj.sj_noterima, '-') AS NoTerima,
            IFNULL(h.pl_sj_nomor, '-') AS NoSJFinal,
            h.pl_ket AS Keterangan,
            
            -- Agregat
            COUNT(d.pld_kode) AS JmlJenis,
            CAST(COALESCE(SUM(d.pld_jumlah), 0) AS UNSIGNED) AS TotalQty

        FROM tpacking_list_hdr h
        INNER JOIN tpacking_list_dtl d ON d.pld_nomor = h.pl_nomor
        LEFT JOIN tgudang g ON g.gdg_kode = h.pl_cab_tujuan
        LEFT JOIN tdc_sj_hdr sj ON sj.sj_nomor = h.pl_sj_nomor
        
        WHERE h.pl_tanggal BETWEEN ? AND ?
        -- Opsional: Filter Cabang User jika bukan orang gudang pusat
        -- AND h.pl_cab_tujuan = ? 

        GROUP BY h.pl_nomor 
        ORDER BY h.pl_tanggal DESC, h.pl_nomor DESC
    `;

    const [rows] = await pool.query(query, [startDate, endDate]);

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error getHistory PackingList:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * 7. Ambil Detail Item untuk Riwayat (Expand)
 */
const getHistoryDetail = async (req, res) => {
  const { nomor } = req.params;

  try {
    const query = `
        SELECT 
            d.pld_kode AS Kode,
            TRIM(CONCAT(a.brg_jeniskaos, " ", a.brg_tipe, " ", a.brg_lengan, " ", a.brg_jeniskain, " ", a.brg_warna)) AS Nama,
            d.pld_ukuran AS Ukuran,
            CAST(d.pld_jumlah AS UNSIGNED) AS Jumlah
        FROM tpacking_list_dtl d
        LEFT JOIN tbarangdc a ON a.brg_kode = d.pld_kode
        WHERE d.pld_nomor = ?
        ORDER BY d.pld_kode, d.pld_ukuran
    `;

    const [rows] = await pool.query(query, [nomor]);

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error getHistoryDetail PackingList:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  savePackingList,
  getPackingListDetail,
  loadItemsFromRequest,
  findProductByBarcode,
  searchPermintaanOpen,
  getHistory,
  getHistoryDetail,
};
