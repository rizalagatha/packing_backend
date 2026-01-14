const pool = require("../config/database");
const { format } = require("date-fns");
const whatsappService = require("../services/whatsapp.service"); // Pastikan import service
const multer = require("multer");

// Konfigurasi Multer (Simpan di RAM agar cepat, gak perlu simpan ke Harddisk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // Max 5MB
}).single("image"); // 'image' adalah nama key field dari frontend

// --- Helper Functions ---
const toSqlDate = (date) => format(new Date(date), "yyyy-MM-dd");
const toSqlDateTime = (date) => format(new Date(date), "yyyy-MM-dd HH:mm:ss");
const applyRounding = (num) => Math.round(num);

const generateNewInvNumber = async (gudang, tanggal) => {
  const date = new Date(tanggal);
  const prefix = `${gudang}.INV.${format(date, "yyMM")}.`;
  const query = `SELECT IFNULL(MAX(RIGHT(inv_nomor, 4)), 0) + 1 AS next_num FROM tinv_hdr WHERE inv_nomor LIKE ?;`;
  const [rows] = await pool.query(query, [`${prefix}%`]);
  return `${prefix}${rows[0].next_num.toString().padStart(4, "0")}`;
};

const generateNewSetorNumber = async (connection, cabang, tanggal) => {
  const prefix = `${cabang}.STR.${format(new Date(tanggal), "yyMM")}.`;
  const [rows] = await connection.query(
    `SELECT IFNULL(MAX(RIGHT(sh_nomor, 4)), 0) + 1 AS next_num FROM tsetor_hdr WHERE sh_nomor LIKE ?`,
    [`${prefix}%`]
  );
  return `${prefix}${rows[0].next_num.toString().padStart(4, "0")}`;
};

// --- API Functions ---

const findProductByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const { cabang } = req.user;

    const query = `
            SELECT 
                d.brgd_barcode AS barcode,
                d.brgd_kode AS kode,
                TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
                d.brgd_ukuran AS ukuran,
                d.brgd_harga AS harga,
                d.brgd_hrg2 AS harga2,
                d.brgd_hrg3 AS harga3,
                d.brgd_hrg4 AS harga4,
                h.brg_ktgp AS kategori,
                IFNULL((
                    SELECT SUM(m.mst_stok_in - m.mst_stok_out) 
                    FROM tmasterstok m 
                    WHERE m.mst_aktif='Y' AND m.mst_cab=? 
                    AND m.mst_brg_kode=d.brgd_kode AND m.mst_ukuran=d.brgd_ukuran
                ), 0) AS stok
            FROM tbarangdc_dtl d
            LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
            WHERE h.brg_aktif=0 AND h.brg_logstok <> 'N' AND d.brgd_barcode = ?
        `;
    const [rows] = await pool.query(query, [cabang, barcode]);

    if (rows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Barcode tidak ditemukan." });
    res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getDefaultCustomer = async (req, res) => {
  try {
    const { cabang } = req.user;
    // --- PERBAIKAN 1: Gunakan ALIAS agar properti di frontend terbaca ---
    const query = `
            SELECT 
                c.cus_kode AS kode, 
                c.cus_nama AS nama, 
                c.cus_alamat AS alamat, 
                c.cus_kota AS kota, 
                c.cus_telp AS telp, 
                x.clh_level AS level_kode
            FROM tcustomer c
            LEFT JOIN tcustomer_level_history x ON x.clh_cus_kode = c.cus_kode
            WHERE c.cus_cab = ? AND (c.cus_nama LIKE '%RETAIL%' OR c.cus_nama LIKE 'RETAIL%')
            ORDER BY x.clh_tanggal DESC LIMIT 1
        `;
    const [rows] = await pool.query(query, [cabang]);
    res.status(200).json({ success: true, data: rows[0] || null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const searchRekening = async (req, res) => {
  try {
    const { term } = req.query;
    const { cabang } = req.user;
    const searchTerm = `%${term || ""}%`;

    const query = `
            SELECT 
                rek_kode AS kode,
                rek_nama AS nama,
                rek_rekening AS rekening
            FROM finance.trekening 
            WHERE rek_kaosan LIKE ? 
              AND (rek_kode LIKE ? OR rek_nama LIKE ?)
            LIMIT 20;
        `;

    const [rows] = await pool.query(query, [
      `%${cabang}%`,
      searchTerm,
      searchTerm,
    ]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error searchRekening:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari rekening." });
  }
};

const savePenjualan = async (req, res) => {
  const { header, items, payment, totals } = req.body;
  const user = req.user;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Validasi Customer
    const customerKode = header.customer?.kode || header.customer?.cus_kode;
    if (!customerKode) {
      throw new Error("Data customer tidak valid (Kode kosong).");
    }

    // 2. Inisialisasi Nomor dan ID
    const invNomor = await generateNewInvNumber(user.cabang, header.tanggal);
    const idrec =
      header.idrec ||
      `${user.cabang}INV${format(new Date(), "yyyyMMddHHmmssSSS")}`;
    const piutangNomor = `${customerKode}${invNomor}`;

    // 3. Perhitungan Nominal (Mengikuti Logika Web)
    const subTotal = applyRounding(totals.subTotal);
    const totalDiskonFaktur = applyRounding(totals.totalDiskonFaktur || 0);
    const biayaKirim = applyRounding(header.biayaKirim || 0);
    const grandTotal = applyRounding(totals.grandTotal);

    const pundiAmal = Number(payment.pundiAmal || 0);
    const bayarTunai = Number(payment.tunai || 0);
    const bayarTransfer = Number(payment.transfer?.nominal || 0);

    // Hitung Kembalian Total sebelum Pundi Amal
    const totalBayarInput = bayarTunai + bayarTransfer;
    const kembalianTotal = Math.max(totalBayarInput - grandTotal, 0);

    // inv_rptunai (Tunai Bersih) = Tunai yang dibayarkan dikurangi kembalian (seperti di web)
    const bayarTunaiBersih = Math.max(bayarTunai - kembalianTotal, 0);

    // inv_kembali (Kembalian Final) = Kembalian setelah dipotong pundi amal
    const kembalianFinal = Math.max(kembalianTotal - pundiAmal, 0);

    // 4. Generate Nomor Setoran jika ada Transfer
    let nomorSetoran = "";
    if (bayarTransfer > 0) {
      nomorSetoran = await generateNewSetorNumber(
        connection,
        user.cabang,
        header.tanggal
      );
    }

    // 5. INSERT tinv_hdr
    const headerSql = `
      INSERT INTO tinv_hdr (
        inv_idrec, inv_nomor, inv_tanggal, inv_cab, 
        inv_cus_kode, inv_cus_level, inv_ket, inv_sc,
        inv_disc, inv_bkrm, inv_dp, inv_bayar, inv_pundiamal,
        inv_rptunai, inv_rpcard, inv_nosetor, inv_novoucher, inv_rpvoucher, 
        inv_kembali, user_create, date_create
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, '', 0, ?, ?, NOW())`;

    await connection.query(headerSql, [
      idrec,
      invNomor,
      toSqlDate(header.tanggal),
      user.cabang,
      customerKode,
      header.customer.level_kode || "1",
      header.keterangan || "Penjualan Mobile",
      user.kode,
      totalDiskonFaktur,
      biayaKirim,
      totalBayarInput, // inv_bayar (Total uang masuk)
      pundiAmal,
      bayarTunaiBersih, // inv_rptunai (Tunai Bersih)
      bayarTransfer, // inv_rpcard
      nomorSetoran, // inv_nosetor
      kembalianFinal, // inv_kembali
      user.kode,
    ]);

    // 6. INSERT tinv_dtl
    const detailValues = items.map((item, index) => {
      const invdIdrec = `${invNomor.replace(/\./g, "")}${String(
        index + 1
      ).padStart(3, "0")}`;
      return [
        invdIdrec,
        invNomor,
        item.kode,
        item.ukuran,
        item.jumlah,
        0,
        item.jumlah,
        Number(item.harga),
        0,
        0,
        Number(item.diskonRp || 0),
        "",
        index + 1,
      ];
    });

    if (detailValues.length > 0) {
      await connection.query(
        `INSERT INTO tinv_dtl (invd_idrec, invd_inv_nomor, invd_kode, invd_ukuran, invd_jumlah, invd_mstpesan, invd_mststok, invd_harga, invd_hpp, invd_disc, invd_diskon, invd_sd_nomor, invd_nourut) VALUES ?`,
        [detailValues]
      );
    }

    // 7. LOGIKA PIUTANG (tpiutang_hdr & tpiutang_dtl)
    // Nominal Header Piutang = Total Invoice (Bottom-up)
    await connection.query(
      `INSERT INTO tpiutang_hdr (ph_nomor, ph_tanggal, ph_cus_kode, ph_inv_nomor, ph_top, ph_nominal, ph_cab) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        piutangNomor,
        toSqlDate(header.tanggal),
        customerKode,
        invNomor,
        0,
        grandTotal,
        user.cabang,
      ]
    );

    // Detail Debet: Penjualan
    await connection.query(
      `INSERT INTO tpiutang_dtl (pd_sd_angsur, pd_ph_nomor, pd_tanggal, pd_uraian, pd_debet, pd_kredit, pd_ket) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `${user.cabang}INV${format(new Date(), "yyyyMMddHHmmssSSS")}`,
        piutangNomor,
        toSqlDateTime(header.tanggal),
        "Penjualan",
        grandTotal,
        0,
        "",
      ]
    );

    // Detail Kredit: Pembayaran Tunai (Bersih)
    if (bayarTunaiBersih > 0) {
      await connection.query(
        `INSERT INTO tpiutang_dtl (pd_sd_angsur, pd_ph_nomor, pd_tanggal, pd_uraian, pd_debet, pd_kredit, pd_ket) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `${user.cabang}CASH${format(new Date(), "yyyyMMddHHmmssSSS")}`,
          piutangNomor,
          toSqlDateTime(header.tanggal),
          "Bayar Tunai",
          0,
          bayarTunaiBersih,
          "",
        ]
      );
    }

    // Detail Kredit: Pembayaran Transfer
    if (bayarTransfer > 0) {
      await connection.query(
        `INSERT INTO tpiutang_dtl (pd_sd_angsur, pd_ph_nomor, pd_tanggal, pd_uraian, pd_debet, pd_kredit, pd_ket) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `${user.cabang}TRF${format(new Date(), "yyyyMMddHHmmssSSS")}`,
          piutangNomor,
          toSqlDateTime(header.tanggal),
          "Bayar Transfer",
          0,
          bayarTransfer,
          nomorSetoran,
        ]
      );
    }

    // 8. INSERT tsetor (Jika Transfer) - Menyimpan Akun dan Rekening
    if (bayarTransfer > 0) {
      const idrecSetor = `${user.cabang}SH${format(
        new Date(),
        "yyyyMMddHHmmssSSS"
      )}`;

      // Ambil info bank dari payment.transfer.akun
      const kodeBank = payment.transfer?.akun?.kode || "";
      const norekBank = payment.transfer?.akun?.rekening || "";

      await connection.query(
        `INSERT INTO tsetor_hdr (
          sh_idrec, sh_nomor, sh_cus_kode, sh_tanggal, sh_jenis, 
          sh_nominal, sh_akun, sh_norek, sh_tgltransfer, sh_otomatis, user_create, date_create
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'Y', ?, NOW())`,
        [
          idrecSetor,
          nomorSetoran,
          customerKode,
          toSqlDateTime(header.tanggal),
          bayarTransfer,
          kodeBank,
          norekBank,
          toSqlDateTime(header.tanggal),
          user.kode,
        ]
      );

      await connection.query(
        `INSERT INTO tsetor_dtl (sd_idrec, sd_sh_nomor, sd_tanggal, sd_inv, sd_bayar, sd_ket, sd_angsur, sd_nourut) VALUES (?, ?, ?, ?, ?, 'PEMBAYARAN DARI KASIR MOBILE', ?, 1)`,
        [
          `${user.cabang}SD${format(new Date(), "yyyyMMddHHmmssSSS")}`,
          nomorSetoran,
          toSqlDateTime(header.tanggal),
          invNomor,
          bayarTransfer,
          `${user.cabang}KS${format(new Date(), "yyyyMMddHHmmssSSS")}`,
        ]
      );
    }

    await connection.commit();
    res
      .status(201)
      .json({
        success: true,
        message: `Penjualan ${invNomor} berhasil.`,
        data: { nomor: invNomor },
      });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error savePenjualan:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// 5. Get Active Promos
const getActivePromos = async (req, res) => {
  try {
    const { tanggal } = req.query;
    const { cabang } = req.user;

    const query = `
            SELECT 
                p.pro_nomor, p.pro_judul, p.pro_totalrp, p.pro_disrp
            FROM tpromo p
            INNER JOIN tpromo_cabang c ON c.pc_nomor = p.pro_nomor AND c.pc_cab = ?
            WHERE p.pro_f1 = "N" -- Promo otomatis/header
              AND ? BETWEEN p.pro_tanggal1 AND p.pro_tanggal2;
        `;

    const [rows] = await pool.query(query, [cabang, tanggal]);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getActivePromos:", error);
    res.status(500).json({ success: false, message: "Gagal memuat promo." });
  }
};

// 5. Get Print Data (Struk)
const getPrintData = async (req, res) => {
  try {
    const { nomor } = req.params;

    // Query Header + Info Toko (tgudang)
    const headerQuery = `
            SELECT 
                h.inv_nomor, h.inv_tanggal, h.user_create, h.date_create,
                h.inv_bayar, h.inv_kembali, h.inv_pundiamal,
                h.inv_disc AS diskon_faktur,
                
                -- Info Toko
                g.gdg_inv_nama AS perush_nama,
                g.gdg_inv_alamat AS perush_alamat,
                g.gdg_inv_telp AS perush_telp,
                g.gdg_inv_instagram,
                g.gdg_inv_fb,
                g.gdg_akun,
                g.gdg_transferbank,

                -- Info Customer (TAMBAHAN INI)
                c.cus_nama,
                c.cus_telp

            FROM tinv_hdr h
            LEFT JOIN tgudang g ON g.gdg_kode = h.inv_cab
            LEFT JOIN tcustomer c ON c.cus_kode = h.inv_cus_kode
            WHERE h.inv_nomor = ?
        `;

    const [headerRows] = await pool.query(headerQuery, [nomor]);
    if (headerRows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Invoice tidak ditemukan." });
    const header = headerRows[0];

    // Query Details
    const detailQuery = `
            SELECT 
                d.invd_kode, d.invd_ukuran, d.invd_jumlah, 
                d.invd_harga, d.invd_diskon,
                TRIM(
                    COALESCE(
                        CONCAT(b.brg_jeniskaos, " ", b.brg_tipe, " ", b.brg_lengan, " ", b.brg_jeniskain, " ", b.brg_warna),
                        f.sd_nama, 
                        d.invd_kode
                    )
                ) AS nama_barang
            FROM tinv_dtl d
            LEFT JOIN tbarangdc b ON b.brg_kode = d.invd_kode
            LEFT JOIN tsodtf_hdr f ON f.sd_nomor = d.invd_kode
            WHERE d.invd_inv_nomor = ?
        `;
    const [details] = await pool.query(detailQuery, [nomor]);

    // Hitung Summary
    let subTotal = 0;
    const items = details.map((item) => {
      const totalItem = item.invd_jumlah * (item.invd_harga - item.invd_diskon);
      subTotal += totalItem;
      return { ...item, total: totalItem };
    });

    const grandTotal = subTotal - (header.diskon_faktur || 0);

    const data = {
      header: { ...header, grandTotal, subTotal },
      details: items,
    };

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error getPrintData:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// 6. Send Receipt WA (UPDATE LENGKAP)
const sendReceiptWa = async (req, res) => {
  try {
    const { nomor, hp } = req.body;
    const { cabang } = req.user;

    // 1. Validasi & Format HP
    if (!hp)
      return res
        .status(400)
        .json({ success: false, message: "Nomor HP wajib diisi." });

    let cleanHp = hp.toString().replace(/[^0-9]/g, "");
    if (cleanHp.startsWith("0")) cleanHp = "62" + cleanHp.slice(1);

    // 2. Ambil Header Transaksi
    const [rows] = await pool.query(
      `SELECT h.*, g.gdg_inv_nama 
       FROM tinv_hdr h 
       LEFT JOIN tgudang g ON g.gdg_kode = h.inv_cab 
       WHERE inv_nomor = ?`,
      [nomor]
    );
    if (!rows.length)
      return res.status(404).json({ message: "Invoice not found" });
    const hdr = rows[0];

    // 3. Ambil Detail (DENGAN NAMA BARANG LENGKAP)
    // Perhatikan bagian TRIM(CONCAT(...)) di bawah ini
    const [dtl] = await pool.query(
      `SELECT d.*, 
       TRIM(CONCAT(b.brg_jeniskaos, " ", b.brg_tipe, " ", b.brg_lengan, " ", b.brg_jeniskain, " ", b.brg_warna)) AS nama_lengkap
       FROM tinv_dtl d 
       LEFT JOIN tbarangdc b ON b.brg_kode = d.invd_kode 
       WHERE invd_inv_nomor = ?`,
      [nomor]
    );

    // Helper Formatting
    const padRight = (str, len) => (str + " ".repeat(len)).slice(0, len);
    const padLeft = (str, len) => (" ".repeat(len) + str).slice(-len);
    const formatRupiah = (num) => parseInt(num).toLocaleString("id-ID");

    // 4. Susun Pesan (Format Monospace)
    let message = "```";
    message += `STRUK BELANJA - ${hdr.gdg_inv_nama}\n`;
    message += `No : ${hdr.inv_nomor}\n`;
    message += `Tgl: ${format(new Date(hdr.inv_tanggal), "dd-MM-yyyy")}\n`;
    message += `------------------------------\n`;

    let subTotal = 0;
    dtl.forEach((d) => {
      const hargaSatuan = d.invd_harga - d.invd_diskon;
      const total = d.invd_jumlah * hargaSatuan;
      subTotal += total;

      // BARIS 1: Nama Barang Lengkap
      // Gunakan alias 'nama_lengkap' yang kita buat di query tadi
      const namaBarang = d.nama_lengkap || "Barang Tanpa Nama";
      message += `${namaBarang} (${d.invd_ukuran})\n`;

      // BARIS 2: Hitungan Harga
      const qtyHarga = `${d.invd_jumlah} x ${formatRupiah(hargaSatuan)}`;
      const totalStr = formatRupiah(total);

      // Hitung spasi agar rata kanan
      const spaceNeeded = 30 - qtyHarga.length - totalStr.length;
      const spaces = spaceNeeded > 0 ? " ".repeat(spaceNeeded) : " ";

      message += `${qtyHarga}${spaces}${totalStr}\n`;
    });

    const grandTotal = subTotal - (hdr.inv_disc || 0);

    message += `------------------------------\n`;

    // FOOTER
    message += `Total      : ${padLeft(formatRupiah(subTotal), 17)}\n`;
    if (hdr.inv_disc > 0) {
      message += `Diskon     : ${padLeft(
        "-" + formatRupiah(hdr.inv_disc),
        17
      )}\n`;
    }
    message += `Grand Total: ${padLeft(formatRupiah(grandTotal), 17)}\n`;

    if (hdr.inv_bayar > 0) {
      message += `Bayar      : ${padLeft(formatRupiah(hdr.inv_bayar), 17)}\n`;
      message += `Kembali    : ${padLeft(formatRupiah(hdr.inv_kembali), 17)}\n`;
    }

    message += `\n`;
    message += `      Terima Kasih!      \n`;
    message += "```";

    // 5. Kirim via Baileys Service
    const result = await whatsappService.sendMessageFromClient(
      cabang,
      cleanHp,
      message
    );

    if (result.success) {
      res
        .status(200)
        .json({ success: true, message: "Struk terkirim ke WhatsApp." });
    } else {
      res.status(400).json({ success: false, message: result.error });
    }
  } catch (error) {
    console.error("Error sendReceiptWa:", error);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan server." });
  }
};

// 7. Send Receipt WA (VERSI GAMBAR)
const sendReceiptWaImage = async (req, res) => {
  // Log saat request masuk
  console.log("[UPLOAD] Menerima request upload gambar...");

  upload(req, res, async function (err) {
    if (err) {
      console.error("[UPLOAD ERROR] Multer Error:", err);
      return res
        .status(400)
        .json({ success: false, message: "Gagal upload gambar (Multer)." });
    }

    try {
      // LOG DATA YANG DITERIMA
      console.log("[UPLOAD] Body:", req.body); // Cek apakah 'hp' dan 'caption' masuk
      console.log("[UPLOAD] File:", req.file ? "Ada File" : "TIDAK ADA FILE");

      const { hp, caption } = req.body;
      const file = req.file;
      const { cabang } = req.user;

      // VALIDASI DETIL
      if (!file) {
        console.error("[UPLOAD FAIL] File kosong");
        return res
          .status(400)
          .json({
            success: false,
            message: "File gambar tidak terbaca di server.",
          });
      }
      if (!hp) {
        console.error("[UPLOAD FAIL] Nomor HP kosong");
        return res
          .status(400)
          .json({ success: false, message: "Nomor HP wajib diisi." });
      }

      // Format HP
      let cleanHp = hp.toString().replace(/[^0-9]/g, "");
      if (cleanHp.startsWith("0")) cleanHp = "62" + cleanHp.slice(1);

      console.log(`[UPLOAD] Mengirim ke Service WA (${cleanHp})...`);

      // Kirim ke Service Baileys
      const result = await whatsappService.sendImageFromClient(
        cabang,
        cleanHp,
        file.buffer,
        caption || "Struk Belanja"
      );

      if (result.success) {
        console.log("[UPLOAD] Sukses terkirim!");
        res
          .status(200)
          .json({ success: true, message: "Struk Gambar Terkirim!" });
      } else {
        console.error("[UPLOAD] Gagal di Baileys:", result.error);
        res.status(400).json({ success: false, message: result.error });
      }
    } catch (error) {
      console.error("[UPLOAD SERVER ERROR]", error); // <--- INI AKAN MENJELASKAN ERROR 500
      res
        .status(500)
        .json({ success: false, message: "Server Error: " + error.message });
    }
  });
};

module.exports = {
  findProductByBarcode,
  getDefaultCustomer,
  savePenjualan,
  searchRekening,
  getActivePromos,
  getPrintData, // -> Baru
  sendReceiptWa, // -> Baru
  sendReceiptWaImage,
};
