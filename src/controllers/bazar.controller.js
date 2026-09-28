const pool = require("../config/database");

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

    await connection.query(
      `INSERT INTO tinv_hdr_tmp (
        inv_id, inv_nomor, inv_tanggal, inv_cus_kode,
        inv_rptunai, inv_rpvoucher, inv_rpcard, inv_nocard, inv_namabank,
        inv_jeniscard, inv_nosetor, user_create, date_create, inv_klerek,
        inv_ket, inv_kembali
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), '0', ?, ?)`,
      [
        invId,
        nomor,
        tanggalSql,
        header.so_customer,
        cash,
        voucher,
        card,
        header.so_bank_card || "",
        header.so_bank_name || "",
        invJeniscard,
        invNosetor,
        kasir,
        "BAZAR ANDROID",
        kembali,
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
        [invId, invdIdd, nomor, itemCode, itemSize, itemQty, d.harga, 0, i + 1],
      );

      await connection.query(
        `UPDATE tmasterstok
         SET mst_stok_out = mst_stok_out + ?
         WHERE mst_brg_kode = ? AND mst_cab = ? AND mst_ukuran = ?`,
        [itemQty, itemCode, cabang, itemSize],
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

module.exports = {
  downloadMasterBazar,
  uploadKoreksiBazar,
  uploadBazarSales,
  createBazarCustomer,
  checkoutBazar,
  getBazarRekening,
};
