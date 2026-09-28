const pool = require("../config/database");
const { PENDING_SALES_SQL } = require("../services/bazarPending.service");

const downloadMasterBazar = async (req, res) => {
  // 1. Ambil parameter cabang dari query string (WAJIB ADA)
  const { cabang } = req.query; // <--- PENTING: Ambil dari URL (?cabang=B01)

  try {
    const queryBarang = `
      SELECT 
        TRIM(d.brgd_barcode) AS barcode,
        d.brgd_kode AS kode,
        TRIM(CONCAT(
          IFNULL(h.brg_jeniskaos, ''), ' ', 
          IFNULL(h.brg_tipe, ''), ' ', 
          IFNULL(h.brg_lengan, ''), ' ', 
          IFNULL(h.brg_jeniskain, ''), ' ', 
          IFNULL(h.brg_warna, '')
        )) AS nama,
        IFNULL(d.brgd_ukuran, '') AS ukuran,
        IFNULL(d.brgd_harga, 0) AS harga_jual,
        IFNULL(d.brgd_hrg1, 0) AS harga_spesial,
        h.brg_minqty AS promo_qty, 
        h.brg_ket AS keterangan,
        IFNULL(h.brg_ktg, '') AS kategori,
        IFNULL(h.brg_ktgp, '') AS tipe_produk,
        IFNULL(h.brg_jeniskain, '') AS jenis_kain,
        COALESCE(
          (SELECT img_url FROM tbarangdc_images WHERE img_brg_kode = h.brg_kode ORDER BY img_index ASC LIMIT 1),
          h.brg_gambar_url
        ) AS gambar_url
      FROM tbarangdc_dtl d
      LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
      ORDER BY 
        (COALESCE(
          (SELECT img_url FROM tbarangdc_images WHERE img_brg_kode = h.brg_kode ORDER BY img_index ASC LIMIT 1),
          h.brg_gambar_url
        ) IS NULL) ASC,
        d.brgd_barcode ASC;
    `;

    const queryCustomer = `
      SELECT 
        cus_kode, 
        cus_nama, 
        IFNULL(cus_alamat, '') as cus_alamat,
        cus_cab -- [TAMBAHKAN INI]
      FROM tcustomer 
      ORDER BY cus_nama ASC;
    `;

    const queryRekening = `
      SELECT DISTINCT
        rek_rekening AS nomor_rekening, 
        rek_nama AS nama_bank,
        rek_kode AS kode
      FROM finance.trekening 
      WHERE rek_isaktif = 0
        AND rek_kaosan LIKE ? 
      ORDER BY rek_nama ASC
    `; // Tip: Hapus tanda titik koma (;) di dalam string query agar lebih aman

    // 2. Jalankan query. Perhatikan argumen ke-2 di pool.query(queryRekening)
    const [[products], [customers], [rekening]] = await Promise.all([
      pool.query(queryBarang),
      pool.query(queryCustomer),
      pool.query(queryRekening, [`%${cabang || ""}%`]), // <--- PENTING: Kirim parameter array disini!
    ]);

    res.status(200).json({
      success: true,
      message: "Data master bazar berhasil dimuat.",
      data: {
        products: products,
        customers: customers,
        rekening: rekening,
      },
    });
  } catch (error) {
    console.error("Error downloadMasterBazar:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data master.",
    });
  }
};

const uploadKoreksiBazar = async (req, res) => {
  const { header, details, targetCabang } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Simpan Header (tkor_hdr)
    const qHdr = `
      INSERT INTO tkor_hdr 
      (korh_nomor, korh_tanggal, korh_notes, korh_gdg_kode, korh_total, date_create, user_create)
      VALUES (?, ?, ?, ?, ?, NOW(), ?)
    `;
    await connection.query(qHdr, [
      header.no_koreksi,
      header.tanggal,
      "KOREKSI ANDROID BAZAR",
      targetCabang,
      header.total_nilai || 0,
      header.operator || "ADMIN",
    ]);

    // 2. Simpan Detail (tkor_dtl)
    const qDtl = `
      INSERT INTO tkor_dtl 
      (kord_korh_nomor, kord_brg_kode, kord_qty, kord_stok)
      VALUES (?, ?, ?, ?)
    `;

    for (const item of details) {
      await connection.query(qDtl, [
        header.no_koreksi,
        item.barcode,
        item.selisih, // Nilai selisih (bisa plus atau minus)
        item.qty_sistem,
      ]);
    }

    await connection.commit();
    res
      .status(200)
      .json({ success: true, message: "Koreksi stok berhasil di-upload." });
  } catch (error) {
    await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(200).json({
        success: true,
        message: "Koreksi ini sudah tersimpan sebelumnya.",
      });
    }
    console.error("Error uploadKoreksiBazar:", error);
    res.status(500).json({
      success: false,
      message: "Gagal menyimpan koreksi ke database pusat.",
    });
  } finally {
    connection.release();
  }
};

const generateNewSetorNomor = async (connection, tanggal, cabang) => {
  const date = new Date(tanggal);
  const ayymm =
    date.getFullYear().toString().slice(-2) +
    (date.getMonth() + 1).toString().padStart(2, "0");
  const prefix = `${cabang}.STR.${ayymm}.`;

  const [rows] = await connection.query(
    "SELECT IFNULL(MAX(RIGHT(sh_nomor, 4)), 0) as max_nomor FROM tsetor_hdr WHERE LEFT(sh_nomor, 12) = ?",
    [prefix],
  );

  const nextNum = parseInt(rows[0].max_nomor, 10) + 1;
  return `${prefix}${String(nextNum).padStart(4, "0")}`;
};

const uploadBazarSales = async (req, res) => {
  const { sales, targetCabang } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Ambil waktu sekarang untuk base ID (14 digit: YYYYMMDDHHMMSS)
    const now = new Date();
    const timePart =
      now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, "0") +
      now.getDate().toString().padStart(2, "0") +
      now.getHours().toString().padStart(2, "0") +
      now.getMinutes().toString().padStart(2, "0") +
      now.getSeconds().toString().padStart(2, "0");

    for (let notaIdx = 0; notaIdx < sales.length; notaIdx++) {
      const { header, details } = sales[notaIdx];
      const invIdHeader =
        `${timePart}.${(notaIdx + 1).toString().padStart(2, "0")}00`.substring(
          0,
          20,
        );
      const formattedDate = header.so_tanggal.substring(0, 10);
      let cleanNomor = header.so_nomor.substring(0, 20);

      // --- LOGIKA SETORAN (CARD/TRANSFER) ---
      let inv_nosetor = "";
      let inv_jeniscard = "";
      if (header.so_card > 0) {
        inv_nosetor = await generateNewSetorNomor(
          connection,
          formattedDate,
          targetCabang,
        );
        inv_jeniscard = "D"; // 'D' untuk Debit sesuai data lama
      }

      const [existing] = await connection.query(
        `SELECT 1 FROM tinv_hdr_tmp WHERE inv_nomor = ? LIMIT 1`,
        [cleanNomor],
      );
      if (existing.length > 0) {
        continue; // nota sudah pernah masuk, jangan proses (dan potong stok) lagi
      }

      await connection.query(`DELETE FROM tinv_hdr_tmp WHERE inv_nomor = ?`, [
        cleanNomor,
      ]);
      await connection.query(
        `DELETE FROM tinv_dtl_tmp WHERE invd_inv_nomor = ?`,
        [cleanNomor],
      );

      // 5. INSERT HEADER
      await connection.query(
        `INSERT INTO tinv_hdr_tmp (
          inv_id, inv_nomor, inv_tanggal, inv_cus_kode, 
          inv_rptunai, inv_rpcard, inv_nocard, inv_namabank, inv_jeniscard, inv_nosetor,
          user_create, date_create, inv_klerek, inv_ket, inv_kembali
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '0', ?, ?)`,
        [
          invIdHeader,
          cleanNomor,
          formattedDate,
          header.so_customer,
          header.so_cash || 0,
          header.so_card || 0,
          header.so_bank_card || "",
          header.so_bank_name || "",
          inv_jeniscard,
          inv_nosetor,
          header.so_user_kasir,
          "BAZAR ANDROID",
          header.so_kembali || 0,
        ],
      );

      // 6. INSERT DETAIL
      for (let i = 0; i < details.length; i++) {
        const d = details[i];
        const itemCode = d.barcode || d.sod_brg_kode;
        const itemQty = d.qty || d.sod_qty;
        const itemSize = d.ukuran || d.sod_ukuran || "";

        // 7. GENERATE invd_idd (PK Detail) - Total 20 Karakter
        // Format: YYYYMMDDHHMMSS + "." + NoUrutNota(2) + NoUrutItem(3)
        // Contoh: 20260120195506.01001 (Item 1), 20260120195506.01002 (Item 2)
        const invdIdd = `${timePart}.${(notaIdx + 1).toString().padStart(2, "0")}${(i + 1).toString().padStart(3, "0")}`;

        await connection.query(
          `INSERT INTO tinv_dtl_tmp (
            invd_id, 
            invd_idd, 
            invd_inv_nomor, 
            invd_kode, 
            invd_ukuran, 
            invd_jumlah, 
            invd_harga, 
            invd_diskon, 
            invd_nourut
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            invIdHeader, // invd_id merujuk ke ID di Header
            invdIdd, // invd_idd (PK UNIK)
            cleanNomor,
            itemCode,
            itemSize,
            itemQty,
            d.harga || d.sod_harga,
            0,
            i + 1,
          ],
        );

        // 8. UPDATE STOK
        await connection.query(
          `UPDATE tmasterstok 
           SET mst_stok_out = mst_stok_out + ? 
           WHERE mst_brg_kode = ? 
             AND mst_cab = ? 
             AND mst_ukuran = ?`,
          [itemQty, itemCode, targetCabang, itemSize],
        );
      }
    }

    await connection.commit();
    res.status(200).json({ success: true, message: "Upload Sukses!" });
  } catch (error) {
    await connection.rollback();
    console.error("Error uploadBazarSales:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    connection.release();
  }
};

// POST /api/bazar/create-customer
const createBazarCustomer = async (req, res) => {
  const { nama, hp, cabang } = req.body;
  const connection = await pool.getConnection();

  try {
    if (!nama || !nama.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Nama pelanggan wajib diisi." });
    }
    if (!cabang) {
      return res
        .status(400)
        .json({ success: false, message: "Cabang tidak diketahui." });
    }

    await connection.beginTransaction();

    // Format kode: <CABANG><5 digit running>, contoh B0200001
    // Kode default "B0200000" (BAZAR UMUM) sengaja di-exclude dari perhitungan running number
    const prefix = cabang;
    const defaultKode = `${prefix}00000`;

    const [rows] = await connection.query(
      `SELECT IFNULL(MAX(CAST(SUBSTRING(cus_kode, LENGTH(?) + 1) AS UNSIGNED)), 0) AS maxNum
       FROM tcustomer
       WHERE cus_kode LIKE ? AND cus_kode <> ?
       FOR UPDATE`,
      [prefix, `${prefix}%`, defaultKode],
    );

    const nextNum = Number(rows[0].maxNum || 0) + 1;
    const newKode = `${prefix}${String(nextNum).padStart(5, "0")}`;

    let cleanHp = (hp || "").toString().replace(/[^0-9]/g, "");
    if (cleanHp.startsWith("0")) {
      cleanHp = "62" + cleanHp.slice(1);
    }

    await connection.query(
      `INSERT INTO tcustomer (cus_kode, cus_nama, cus_telp, cus_cab, cus_alamat, date_create, user_create)
       VALUES (?, ?, ?, ?, '', NOW(), ?)`,
      [newKode, nama.trim(), cleanHp, cabang, req.user?.kode || "BAZAR_APP"],
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Pelanggan baru berhasil disimpan.",
      data: {
        cus_kode: newKode,
        cus_nama: nama.trim(),
        cus_alamat: "",
        cus_telp: cleanHp,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error createBazarCustomer:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal menyimpan pelanggan baru." });
  } finally {
    connection.release();
  }
};

const pad2 = (n) => String(n).padStart(2, "0");

// Diskon item dari promo master (Diskon Item) yang aktif untuk cabang ini.
// Pola sama dengan getActivePromos; bila ada beberapa promo, ambil persen tertinggi.
const resolveItemDiscounts = async (db, cabang, barcodes) => {
  const list = [
    ...new Set(
      (barcodes || [])
        .map((b) => String(b).trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const result = {};
  if (list.length === 0) {
    return result;
  }

  const [rows] = await db.query(
    `SELECT UPPER(TRIM(d.brgd_barcode)) AS barcode,
            MAX(pb.pb_disc) AS persen,
            MAX(pb.pb_diskon) AS rp
     FROM tpromo p
     JOIN tpromo_cabang c ON c.pc_nomor = p.pro_nomor AND c.pc_cab = ?
     JOIN tpromo_barang pb ON pb.pb_nomor = p.pro_nomor
     JOIN tbarangdc_dtl d
       ON d.brgd_kode = pb.pb_brg_kode AND d.brgd_ukuran = pb.pb_ukuran
     WHERE p.pro_f1 = 'N'
       AND CURDATE() BETWEEN p.pro_tanggal1 AND p.pro_tanggal2
       AND (p.pro_mode_barang = 'DISCOUNT' OR p.pro_jenis = 4)
       AND UPPER(TRIM(d.brgd_barcode)) IN (?)
     GROUP BY UPPER(TRIM(d.brgd_barcode))`,
    [cabang, list],
  );
  rows.forEach((r) => {
    result[r.barcode] = {
      persen: Number(r.persen) || 0,
      rp: Number(r.rp) || 0,
    };
  });
  return result;
};

// Diskon per pcs (Rp). Nominal Rp diutamakan, kalau tidak pakai persen.
const unitDiscount = (harga, disc) => {
  if (!disc) {
    return 0;
  }
  const raw = disc.rp > 0 ? disc.rp : Math.round((harga * disc.persen) / 100);
  return Math.max(0, Math.min(raw, harga));
};

const checkoutBazar = async (req, res) => {
  const { header, details, clientToken, kodeKasir } = req.body;
  const cabang = req.user?.cabang || req.body.cabang;

  if (!cabang || !header || !Array.isArray(details) || details.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "Data transaksi tidak lengkap." });
  }
  if (!/^[A-Za-z0-9]{16}$/.test(String(clientToken || ""))) {
    return res
      .status(400)
      .json({ success: false, message: "Token transaksi tidak valid." });
  }
  if (!details.every((d) => d.barcode && Number(d.qty) > 0)) {
    return res
      .status(400)
      .json({ success: false, message: "Ada item dengan qty tidak valid." });
  }

  const kasir =
    String(kodeKasir || "000")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 4) || "000";
  const now = new Date();
  const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const tanggalSql = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const prefix = `${cabang}-${kasir}-${ymd}`;
  const lockName = `bazar_nota:${prefix}`;
  const invId = `${clientToken}0000`;

  const connection = await pool.getConnection();
  let lockAcquired = false;
  let inTransaction = false;

  try {
    const [[lockRow]] = await connection.query(
      "SELECT GET_LOCK(?, 10) AS got",
      [lockName],
    );
    lockAcquired = Number(lockRow.got) === 1;
    if (!lockAcquired) {
      return res
        .status(503)
        .json({ success: false, message: "Server sibuk, coba lagi sebentar." });
    }

    // Retry dengan token yang sama: kembalikan nota lama, jangan proses ulang
    const [dup] = await connection.query(
      "SELECT inv_nomor, date_create FROM tinv_hdr_tmp WHERE inv_id = ? LIMIT 1",
      [invId],
    );
    if (dup.length > 0) {
      return res.status(200).json({
        success: true,
        message: "Nota sudah tersimpan sebelumnya.",
        data: {
          nomor: dup[0].inv_nomor,
          tanggal: new Date(dup[0].date_create || now).toISOString(),
          duplicated: true,
        },
      });
    }

    // Diskon promo divalidasi terhadap master (server sebagai acuan)
    const discMap = await resolveItemDiscounts(
      connection,
      cabang,
      details.map((d) => d.barcode),
    );
    const unitDiskons = details.map((d) =>
      unitDiscount(
        Number(d.harga) || 0,
        discMap[String(d.barcode).trim().toUpperCase()],
      ),
    );
    const diskonTidakSesuai = details.some(
      (d, i) => Math.abs((Number(d.diskonRp) || 0) - unitDiskons[i]) > 0.5,
    );
    if (diskonTidakSesuai) {
      return res.status(409).json({
        success: false,
        code: "PROMO_MISMATCH",
        message:
          "Promo berubah atau belum sinkron. Keranjang diperbarui, cek total lalu ulangi pembayaran.",
      });
    }

    // Nomor berikutnya: cek tmp DAN tinv_hdr (kalau tmp sudah dipindah/dibersihkan)
    const [maxRows] = await connection.query(
      `SELECT IFNULL(MAX(CAST(RIGHT(t.n, 3) AS UNSIGNED)), 0) AS maxNum FROM (
         SELECT inv_nomor AS n FROM tinv_hdr_tmp WHERE inv_nomor LIKE ?
         UNION ALL
         SELECT inv_nomor AS n FROM tinv_hdr WHERE inv_nomor LIKE ?
       ) t`,
      [`${prefix}%`, `${prefix}%`],
    );
    const nomor = `${prefix}${String(Number(maxRows[0].maxNum) + 1).padStart(3, "0")}`;
    if (nomor.length > 20) {
      return res
        .status(400)
        .json({ success: false, message: "Format nomor nota melebihi batas." });
    }

    const cash = Number(header.so_cash) || 0;
    const card = Number(header.so_card) || 0;
    const voucher = Number(header.so_voucher) || 0;
    const kembali = Number(header.so_kembali) || 0;

    let invNosetor = "";
    let invJeniscard = "";
    if (card > 0) {
      invNosetor = await generateNewSetorNomor(connection, tanggalSql, cabang);
      invJeniscard = "D";
    }

    await connection.beginTransaction();
    inTransaction = true;

    const hpCustomer = String(header.so_hp || "")
      .replace(/[^0-9]/g, "")
      .slice(0, 15);

    const namaBank = String(header.so_bank_name || "").slice(0, 30);
    const noCard = String(header.so_bank_card || "").slice(0, 20);

    await connection.query(
      `INSERT INTO tinv_hdr_tmp (
        inv_id, inv_nomor, inv_tanggal, inv_cus_kode,
        inv_rptunai, inv_rpvoucher, inv_rpcard, inv_nocard, inv_namabank,
        inv_jeniscard, inv_nosetor, user_create, date_create, inv_klerek,
        inv_ket, inv_kembali, inv_mem_hp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '0', ?, ?, ?)`,
      [
        invId,
        nomor,
        tanggalSql,
        header.so_customer,
        cash,
        voucher,
        card,
        noCard,
        namaBank,
        invJeniscard,
        invNosetor,
        kasir,
        "BAZAR ANDROID",
        kembali,
        hpCustomer,
      ],
    );

    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      const itemCode = d.barcode;
      const itemQty = Number(d.qty);
      const itemSize = d.ukuran || "";
      const invdIdd = `${clientToken}${String(i + 1).padStart(4, "0")}`;

      await connection.query(
        `INSERT INTO tinv_dtl_tmp (
          invd_id, invd_idd, invd_inv_nomor, invd_kode, invd_ukuran,
          invd_jumlah, invd_harga, invd_diskon, invd_nourut
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invId,
          invdIdd,
          nomor,
          itemCode,
          itemSize,
          itemQty,
          d.harga,
          unitDiskons[i],
          i + 1,
        ],
      );
    }

    await connection.commit();
    inTransaction = false;

    res.status(200).json({
      success: true,
      message: "Transaksi berhasil disimpan.",
      data: { nomor, tanggal: now.toISOString(), duplicated: false },
    });
  } catch (error) {
    if (inTransaction) {
      await connection.rollback();
    }
    console.error("Error checkoutBazar:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal menyimpan transaksi." });
  } finally {
    if (lockAcquired) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
      } catch (e) {
        console.error("Gagal release lock nota:", e.message);
      }
    }
    connection.release();
  }
};

const getBazarRekening = async (req, res) => {
  const cabang = req.user?.cabang || req.query.cabang || "";
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT
         rek_rekening AS rek_nomor,
         rek_nama,
         rek_kode AS kode
       FROM finance.trekening
       WHERE rek_isaktif = 0 AND rek_kaosan LIKE ?
       ORDER BY rek_nama ASC`,
      [`%${cabang}%`],
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getBazarRekening:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat daftar rekening." });
  }
};

// ===== Fase 2 & 3: Bazar online =====

const namaExpr = (a) =>
  `TRIM(CONCAT_WS(' ', ${a}.brg_jeniskaos, ${a}.brg_tipe, ${a}.brg_lengan, ${a}.brg_jeniskain, ${a}.brg_warna))`;

const PRODUCT_SELECT = `
  SELECT
    TRIM(d.brgd_barcode) AS barcode,
    d.brgd_kode AS kode,
    ${namaExpr("h")} AS nama,
    IFNULL(d.brgd_ukuran, '') AS ukuran,
    IFNULL(d.brgd_harga, 0) AS harga_jual,
    IFNULL(d.brgd_hrg1, 0) AS harga_spesial,
    IFNULL(h.brg_minqty, 0) AS promo_qty,
    IFNULL(h.brg_ket, '') AS keterangan,
    IFNULL(h.brg_ktg, '') AS kategori,
    IFNULL(h.brg_ktgp, '') AS tipe_produk,
    IFNULL(h.brg_jeniskain, '') AS jenis_kain,
    COALESCE(
      (SELECT img_url FROM tbarangdc_images WHERE img_brg_kode = h.brg_kode ORDER BY img_index ASC LIMIT 1),
      h.brg_gambar_url
    ) AS gambar_url
  FROM tbarangdc_dtl d
  LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
`;

const normalizeProduct = (r) => ({
  ...r,
  harga_jual: Number(r.harga_jual) || 0,
  harga_spesial: Number(r.harga_spesial) || 0,
  promo_qty: Number(r.promo_qty) || 0,
});

const buildCatalogWhere = ({ q, kategori, tipe, jenisKain }) => {
  const where = ["d.brgd_barcode IS NOT NULL", "TRIM(d.brgd_barcode) <> ''"];
  const params = [];

  const words = String(q || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    const like = `%${w}%`;
    where.push(
      `(d.brgd_barcode LIKE ? OR d.brgd_kode LIKE ? OR CONCAT_WS(' ', h.brg_jeniskaos, h.brg_tipe, h.brg_lengan, h.brg_jeniskain, h.brg_warna) LIKE ?)`,
    );
    params.push(like, like, like);
  }
  if (kategori && kategori !== "SEMUA") {
    where.push("h.brg_ktg = ?");
    params.push(kategori);
  }
  if (tipe && tipe !== "SEMUA") {
    where.push("h.brg_ktgp = ?");
    params.push(tipe);
  }
  if (jenisKain && jenisKain !== "SEMUA") {
    where.push("h.brg_jeniskain = ?");
    params.push(jenisKain);
  }
  return { whereSql: where.join(" AND "), params };
};

// GET /bazar/catalog?q&kategori&tipe&jenisKain&offset&limit&onlyStock=1
const searchBazarCatalog = async (req, res) => {
  const cabang = req.user?.cabang;
  if (!cabang) {
    return res
      .status(400)
      .json({ success: false, message: "Cabang tidak diketahui." });
  }
  try {
    const { q, kategori, tipe, jenisKain } = req.query;
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 60, 1),
      200,
    );
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const onlyStock = String(req.query.onlyStock) === "1";
    const { whereSql, params } = buildCatalogWhere({
      q,
      kategori,
      tipe,
      jenisKain,
    });

    const [rows] = await pool.query(
      `SELECT p.*, (IFNULL(s.stok, 0) - IFNULL(pn.qty, 0)) AS stok
       FROM (${PRODUCT_SELECT} WHERE ${whereSql}) p
       LEFT JOIN (
         SELECT m.mst_brg_kode, m.mst_ukuran, SUM(m.mst_stok_in - m.mst_stok_out) AS stok
         FROM tmasterstok m
         WHERE m.mst_aktif = 'Y' AND m.mst_cab = ?
         GROUP BY m.mst_brg_kode, m.mst_ukuran
       ) s ON s.mst_brg_kode = p.kode AND s.mst_ukuran = p.ukuran
       LEFT JOIN (${PENDING_SALES_SQL}) pn ON pn.kode = p.kode AND pn.ukuran = p.ukuran
       ${onlyStock ? "WHERE (IFNULL(s.stok, 0) - IFNULL(pn.qty, 0)) > 0" : ""}
       ORDER BY (p.gambar_url IS NULL OR p.gambar_url = '') ASC, p.kode ASC, p.barcode ASC
       LIMIT ? OFFSET ?`,
      [...params, cabang, `${cabang}-%`, limit, offset],
    );

    res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        ...normalizeProduct(r),
        stok: Number(r.stok) || 0,
      })),
    });
  } catch (error) {
    console.error("Error searchBazarCatalog:", error);
    res.status(500).json({ success: false, message: "Gagal memuat katalog." });
  }
};

// GET /bazar/product/:barcode  (sekalian stok live di cabang user)
const getBazarProduct = async (req, res) => {
  const cabang = req.user?.cabang;
  const barcode = String(req.params.barcode || "").trim();
  if (!cabang || !barcode) {
    return res
      .status(400)
      .json({ success: false, message: "Barcode/cabang tidak valid." });
  }
  try {
    const [rows] = await pool.query(
      `${PRODUCT_SELECT} WHERE TRIM(d.brgd_barcode) = ? LIMIT 1`,
      [barcode],
    );
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Barang tidak ditemukan." });
    }
    const product = normalizeProduct(rows[0]);
    const [[stokRow]] = await pool.query(
      `SELECT IFNULL(SUM(mst_stok_in - mst_stok_out), 0) AS stok
       FROM tmasterstok
       WHERE mst_aktif = 'Y' AND mst_cab = ? AND mst_brg_kode = ? AND mst_ukuran = ?`,
      [cabang, product.kode, product.ukuran],
    );
    const [[pendRow]] = await pool.query(
      `SELECT IFNULL(SUM(d.invd_jumlah), 0) AS qty
       FROM tinv_hdr_tmp h
       JOIN tinv_dtl_tmp d ON d.invd_inv_nomor = h.inv_nomor
       WHERE h.inv_nomor LIKE ? AND d.invd_kode = ?`,
      [`${cabang}-%`, product.barcode],
    );
    const stok = (Number(stokRow.stok) || 0) - (Number(pendRow.qty) || 0);
    res.status(200).json({ success: true, data: { ...product, stok } });
  } catch (error) {
    console.error("Error getBazarProduct:", error);
    res.status(500).json({ success: false, message: "Gagal memuat barang." });
  }
};

// GET /bazar/filters?onlyStock=1
const getBazarFilterOptions = async (req, res) => {
  const cabang = req.user?.cabang;
  const onlyStock = String(req.query.onlyStock) === "1";

  if (onlyStock && !cabang) {
    return res
      .status(400)
      .json({ success: false, message: "Cabang tidak diketahui." });
  }

  try {
    const distinct = (col) =>
      pool.query(
        `SELECT DISTINCT ${col} AS v FROM tbarangdc WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`,
      );

    // Jenis kain yang punya minimal 1 ukuran berstok di cabang ini
    const jenisKainWithStock = () =>
      pool.query(
        `SELECT DISTINCT h.brg_jeniskain AS v
         FROM tbarangdc h
         JOIN tbarangdc_dtl d ON d.brgd_kode = h.brg_kode
         JOIN (
           SELECT mst_brg_kode, mst_ukuran, SUM(mst_stok_in - mst_stok_out) AS stok
           FROM tmasterstok
           WHERE mst_aktif = 'Y' AND mst_cab = ?
           GROUP BY mst_brg_kode, mst_ukuran
           HAVING stok > 0
         ) s ON s.mst_brg_kode = d.brgd_kode AND s.mst_ukuran = d.brgd_ukuran
         WHERE h.brg_jeniskain IS NOT NULL AND h.brg_jeniskain <> ''
           AND d.brgd_barcode IS NOT NULL AND TRIM(d.brgd_barcode) <> ''
         ORDER BY v`,
        [cabang],
      );

    const [[kategori], [tipe], [jenisKain]] = await Promise.all([
      distinct("brg_ktg"),
      distinct("brg_ktgp"),
      onlyStock ? jenisKainWithStock() : distinct("brg_jeniskain"),
    ]);

    res.status(200).json({
      success: true,
      data: {
        kategori: kategori.map((r) => r.v),
        tipe: tipe.map((r) => r.v),
        jenisKain: jenisKain.map((r) => r.v),
      },
    });
  } catch (error) {
    console.error("Error getBazarFilterOptions:", error);
    res.status(500).json({ success: false, message: "Gagal memuat filter." });
  }
};

// GET /bazar/customers?q=
const searchBazarCustomers = async (req, res) => {
  const like = `%${String(req.query.q || "").trim()}%`;
  try {
    const [rows] = await pool.query(
      `SELECT cus_kode, cus_nama, IFNULL(cus_alamat, '') AS cus_alamat
       FROM tcustomer
       WHERE cus_nama LIKE ? OR cus_kode LIKE ?
       ORDER BY cus_nama ASC
       LIMIT 100`,
      [like, like],
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error searchBazarCustomers:", error);
    res.status(500).json({ success: false, message: "Gagal memuat customer." });
  }
};

// GET /bazar/default-customer
const getBazarDefaultCustomer = async (req, res) => {
  const cabang = req.user?.cabang;
  try {
    const [rows] = await pool.query(
      "SELECT cus_kode AS kode, cus_nama AS nama FROM tcustomer WHERE cus_kode = ? LIMIT 1",
      [`${cabang}00000`],
    );
    res.status(200).json({ success: true, data: rows[0] || null });
  } catch (error) {
    console.error("Error getBazarDefaultCustomer:", error);
    res.status(500).json({ success: false, message: "Gagal memuat customer." });
  }
};

// GET /bazar/history?startDate&endDate  (default 7 hari terakhir)
const getBazarSalesHistory = async (req, res) => {
  const cabang = req.user?.cabang;
  if (!cabang) {
    return res
      .status(400)
      .json({ success: false, message: "Cabang tidak diketahui." });
  }
  const fmt = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  const startDate = req.query.startDate || fmt(weekAgo);
  const endDate = req.query.endDate || fmt(today);

  try {
    const [rows] = await pool.query(
      `SELECT
         h.inv_nomor AS so_nomor,
         h.date_create AS so_tanggal,
         h.inv_cus_kode AS so_customer,
         IFNULL(c.cus_nama, '') AS cus_nama,
         h.user_create AS so_user_kasir,
         COALESCE(NULLIF(h.inv_mem_hp, ''), NULLIF(c.cus_telp, ''), '') AS so_hp,
         (SELECT IFNULL(SUM(d.invd_jumlah * (d.invd_harga - IFNULL(d.invd_diskon, 0))), 0)
          FROM tinv_dtl_tmp d WHERE d.invd_inv_nomor = h.inv_nomor) AS so_total
       FROM tinv_hdr_tmp h
       LEFT JOIN tcustomer c ON c.cus_kode = h.inv_cus_kode
       WHERE h.inv_nomor LIKE ? AND h.inv_tanggal BETWEEN ? AND ?
       ORDER BY h.date_create DESC
       LIMIT 200`,
      [`${cabang}-%`, startDate, endDate],
    );
    res.status(200).json({
      success: true,
      data: rows.map((r) => ({ ...r, so_total: Number(r.so_total) || 0 })),
    });
  } catch (error) {
    console.error("Error getBazarSalesHistory:", error);
    res.status(500).json({ success: false, message: "Gagal memuat riwayat." });
  }
};

// GET /bazar/history/:nomor  -> bentuk sama dengan yang dibaca StrukModal (isBazar)
const getBazarSaleDetail = async (req, res) => {
  const cabang = req.user?.cabang;
  const nomor = String(req.params.nomor || "");
  if (!cabang || !nomor.startsWith(`${cabang}-`)) {
    return res
      .status(404)
      .json({ success: false, message: "Nota tidak ditemukan." });
  }
  try {
    const [hdrRows] = await pool.query(
      `SELECT
         h.inv_nomor AS so_nomor,
         h.date_create AS so_tanggal,
         h.inv_cus_kode AS so_customer,
         IFNULL(c.cus_nama, '') AS cus_nama,
         h.user_create AS so_user_kasir,
         COALESCE(NULLIF(h.inv_mem_hp, ''), NULLIF(c.cus_telp, ''), '') AS so_hp,
         h.inv_rptunai, h.inv_rpcard, h.inv_rpvoucher,
         IFNULL(h.inv_kembali, 0) AS so_kembali
       FROM tinv_hdr_tmp h
       LEFT JOIN tcustomer c ON c.cus_kode = h.inv_cus_kode
       WHERE h.inv_nomor = ? LIMIT 1`,
      [nomor],
    );
    if (hdrRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Nota tidak ditemukan." });
    }

    const [dtlRows] = await pool.query(
      `SELECT
         d.invd_kode AS barcode,
         d.invd_ukuran AS ukuran,
         d.invd_jumlah AS qty,
         d.invd_harga AS harga,
         ${namaExpr("a")} AS nama,
         IFNULL(b.brgd_harga, 0) AS harga_jual,
         IFNULL(b.brgd_hrg1, 0) AS harga_spesial,
         IFNULL(a.brg_minqty, 0) AS promo_qty,
         IFNULL(a.brg_ket, '') AS keterangan
       FROM tinv_dtl_tmp d
       LEFT JOIN tbarangdc_dtl b ON TRIM(b.brgd_barcode) = d.invd_kode
       LEFT JOIN tbarangdc a ON a.brg_kode = b.brgd_kode
       WHERE d.invd_inv_nomor = ?
       ORDER BY d.invd_nourut ASC`,
      [nomor],
    );

    const details = dtlRows.map((d) => ({
      ...d,
      qty: Number(d.qty) || 0,
      harga: Number(d.harga) || 0,
      harga_jual: Number(d.harga_jual) || 0,
      harga_spesial: Number(d.harga_spesial) || 0,
      promo_qty: Number(d.promo_qty) || 0,
    }));

    const h = hdrRows[0];
    const cash = Number(h.inv_rptunai) || 0;
    const card = Number(h.inv_rpcard) || 0;
    const voucher = Number(h.inv_rpvoucher) || 0;

    res.status(200).json({
      success: true,
      data: {
        header: {
          so_nomor: h.so_nomor,
          so_tanggal: h.so_tanggal,
          so_customer: h.so_customer,
          cus_nama: h.cus_nama,
          so_user_kasir: h.so_user_kasir,
          so_hp: h.so_hp,
          so_total: details.reduce(
            (s, i) => s + i.qty * (i.harga - i.diskon),
            0,
          ),
          so_cash: cash,
          so_card: card,
          so_voucher: voucher,
          so_bayar: cash + card + voucher,
          so_kembali: Number(h.so_kembali) || 0,
        },
        details,
      },
    });
  } catch (error) {
    console.error("Error getBazarSaleDetail:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat detail nota." });
  }
};

// GET /bazar/koreksi/history
const getBazarKoreksiHistory = async (req, res) => {
  const cabang = req.user?.cabang;
  try {
    const [rows] = await pool.query(
      `SELECT
         h.korh_nomor AS no_koreksi,
         h.korh_tanggal AS tanggal,
         h.user_create AS operator,
         d.kord_brg_kode AS barcode,
         ${namaExpr("a")} AS nama,
         d.kord_stok AS qty_sistem,
         d.kord_qty AS selisih,
         (d.kord_stok + d.kord_qty) AS qty_fisik
       FROM tkor_hdr h
       JOIN tkor_dtl d ON d.kord_korh_nomor = h.korh_nomor
       LEFT JOIN tbarangdc_dtl b ON TRIM(b.brgd_barcode) = d.kord_brg_kode
       LEFT JOIN tbarangdc a ON a.brg_kode = b.brgd_kode
       WHERE h.korh_gdg_kode = ? AND h.korh_notes = 'KOREKSI ANDROID BAZAR'
       ORDER BY h.date_create DESC, d.kord_brg_kode ASC
       LIMIT 50`,
      [cabang],
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getBazarKoreksiHistory:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat riwayat koreksi." });
  }
};

// GET /bazar/images/:kode  -> semua gambar produk, urut img_index
const getBazarProductImages = async (req, res) => {
  const kode = String(req.params.kode || "").trim();
  if (!kode) {
    return res
      .status(400)
      .json({ success: false, message: "Kode barang tidak valid." });
  }
  try {
    const [rows] = await pool.query(
      `SELECT img_url FROM tbarangdc_images
       WHERE img_brg_kode = ? AND img_url IS NOT NULL AND img_url <> ''
       ORDER BY img_index ASC
       LIMIT 10`,
      [kode],
    );
    let images = rows.map((r) => r.img_url);

    // Fallback: barang lama yang belum punya baris di tbarangdc_images
    if (images.length === 0) {
      const [[hdr]] = await pool.query(
        "SELECT brg_gambar_url FROM tbarangdc WHERE brg_kode = ? LIMIT 1",
        [kode],
      );
      if (hdr?.brg_gambar_url) {
        images = [hdr.brg_gambar_url];
      }
    }

    res.status(200).json({ success: true, data: images });
  } catch (error) {
    console.error("Error getBazarProductImages:", error);
    res.status(500).json({ success: false, message: "Gagal memuat gambar." });
  }
};

// POST /bazar/promo-discounts  { barcodes: [...] }
const getBazarPromoDiscounts = async (req, res) => {
  console.log(
    "[promo-discounts]",
    req.user?.cabang,
    req.body?.barcodes?.length,
  );
  const cabang = req.user?.cabang;
  const barcodes = req.body?.barcodes;
  if (!cabang || !Array.isArray(barcodes) || barcodes.length > 100) {
    return res
      .status(400)
      .json({ success: false, message: "Data tidak valid." });
  }
  try {
    const data = await resolveItemDiscounts(pool, cabang, barcodes);
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error getBazarPromoDiscounts:", error);
    res.status(500).json({ success: false, message: "Gagal memuat promo." });
  }
};

module.exports = {
  downloadMasterBazar,
  uploadKoreksiBazar,
  uploadBazarSales,
  createBazarCustomer,
  checkoutBazar,
  getBazarRekening,
  searchBazarCatalog,
  getBazarProduct,
  getBazarFilterOptions,
  searchBazarCustomers,
  getBazarDefaultCustomer,
  getBazarSalesHistory,
  getBazarSaleDetail,
  getBazarKoreksiHistory,
  getBazarProductImages,
  getBazarPromoDiscounts,
};
