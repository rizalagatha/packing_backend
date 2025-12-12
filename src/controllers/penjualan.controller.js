const pool = require("../config/database");
const { format } = require("date-fns");

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

    // Validasi Customer
    // Fallback: Jika header.customer.kode tidak ada, coba cek properti lain
    const customerKode = header.customer?.kode || header.customer?.cus_kode;
    if (!customerKode) {
      throw new Error(
        "Data customer tidak valid (Kode kosong). Silakan reload halaman."
      );
    }

    const invNomor = await generateNewInvNumber(user.cabang, header.tanggal);
    const idrec = `${user.cabang}INV${format(new Date(), "yyyyMMddHHmmssSSS")}`;
    const piutangNomor = `${customerKode}${invNomor}`;

    const subTotal = applyRounding(totals.subTotal);
    const totalDiskon = applyRounding(totals.totalDiskonFaktur || 0);
    const grandTotal = applyRounding(totals.grandTotal);

    const bayarTunai = applyRounding(Number(payment.tunai || 0));
    const bayarTransfer = applyRounding(Number(payment.transfer?.nominal || 0));
    const totalBayar = bayarTunai + bayarTransfer;

    const kembalian = Math.max(totalBayar - grandTotal, 0);
    const sisaPiutang = Math.max(grandTotal - totalBayar, 0);

    // --- Insert tinv_hdr ---
    await connection.query(
      `INSERT INTO tinv_hdr (
                inv_idrec, inv_nomor, inv_tanggal, inv_cab, 
                inv_cus_kode, inv_cus_level, inv_ket, inv_sc,
                inv_disc, inv_bkrm, inv_dp, inv_bayar, inv_pundiamal,
                inv_rptunai, inv_rpcard, inv_novoucher, inv_rpvoucher, 
                inv_kembali, user_create, date_create
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, '', 0, ?, ?, NOW())`,
      [
        idrec,
        invNomor,
        toSqlDate(header.tanggal),
        user.cabang,
        customerKode,
        header.customer.level_kode || "1",
        header.keterangan || "Penjualan Mobile",
        user.kode,
        totalDiskon,
        0,
        totalBayar,
        bayarTunai,
        bayarTransfer,
        kembalian,
        user.kode,
      ]
    );

    // --- Insert tinv_dtl ---
    const detailValues = items.map((item, index) => {
      const invdIdrec = `${invNomor.replace(/\./g, "")}${String(
        index + 1
      ).padStart(3, "0")}`;
      const harga = Number(item.harga);
      const diskonRp = Number(item.diskonRp || 0);

      return [
        invdIdrec,
        invNomor,
        item.kode,
        item.ukuran,
        item.jumlah,
        0,
        item.jumlah,
        harga,
        0,
        0,
        diskonRp,
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

    // --- Insert tpiutang ---
    if (grandTotal > 0) {
      await connection.query(
        `INSERT INTO tpiutang_hdr (ph_nomor, ph_tanggal, ph_cus_kode, ph_inv_nomor, ph_top, ph_nominal) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          piutangNomor,
          toSqlDate(header.tanggal),
          customerKode,
          invNomor,
          0,
          sisaPiutang,
        ]
      );

      // Detail Tagihan
      const dtlTagihan = [
        `${user.cabang}INV${format(new Date(), "yyyyMMddHHmmssSSS")}`,
        piutangNomor,
        toSqlDateTime(header.tanggal),
        "Penjualan",
        grandTotal,
        0,
        "",
      ];
      await connection.query(
        `INSERT INTO tpiutang_dtl (pd_sd_angsur, pd_ph_nomor, pd_tanggal, pd_uraian, pd_debet, pd_kredit, pd_ket) VALUES (?)`,
        [dtlTagihan]
      );

      if (bayarTunai > 0) {
        const tunaiBersih = Math.max(bayarTunai - kembalian, 0);
        const dtlTunai = [
          `${user.cabang}CASH${format(new Date(), "yyyyMMddHHmmssSSS")}`,
          piutangNomor,
          toSqlDateTime(header.tanggal),
          "Bayar Tunai",
          0,
          tunaiBersih,
          "",
        ];
        await connection.query(
          `INSERT INTO tpiutang_dtl (pd_sd_angsur, pd_ph_nomor, pd_tanggal, pd_uraian, pd_debet, pd_kredit, pd_ket) VALUES (?)`,
          [dtlTunai]
        );
      }

      if (bayarTransfer > 0) {
        const dtlTransfer = [
          `${user.cabang}TRF${format(new Date(), "yyyyMMddHHmmssSSS")}`,
          piutangNomor,
          toSqlDateTime(header.tanggal),
          "Bayar Transfer",
          0,
          bayarTransfer,
          "",
        ];
        await connection.query(
          `INSERT INTO tpiutang_dtl (pd_sd_angsur, pd_ph_nomor, pd_tanggal, pd_uraian, pd_debet, pd_kredit, pd_ket) VALUES (?)`,
          [dtlTransfer]
        );
      }
    }

    // --- Insert tsetor (Jika Transfer) ---
    if (bayarTransfer > 0) {
      const nomorSetor = await generateNewSetorNumber(
        connection,
        user.cabang,
        header.tanggal
      );

      const timestampSetor = format(new Date(), "yyyyMMddHHmmssSSS");
      const idrecSetor = `${user.cabang}SH${timestampSetor}`; // ID Unik Header
      const idrecSetorDtl = `${user.cabang}SD${timestampSetor}`; // ID Unik Detail
      const angsurId = `${user.cabang}KS${timestampSetor}`; // ID Angsur (Penting untuk relasi)

      // Header Setoran
      await connection.query(
        `INSERT INTO tsetor_hdr (sh_idrec, sh_nomor, sh_cus_kode, sh_tanggal, sh_jenis, sh_nominal, sh_otomatis, user_create, date_create) VALUES (?, ?, ?, ?, 1, ?, 'Y', ?, NOW())`,
        [
          idrecSetor,
          nomorSetor,
          customerKode,
          toSqlDateTime(header.tanggal),
          bayarTransfer,
          user.kode,
        ]
      );

      // Detail Setoran
      // --- PERBAIKAN 2: Tambahkan 'sd_angsur' dan gunakan 'idrecSetorDtl' ---
      await connection.query(
        `INSERT INTO tsetor_dtl (sd_idrec, sd_sh_nomor, sd_tanggal, sd_inv, sd_bayar, sd_ket, sd_angsur, sd_nourut) VALUES (?, ?, ?, ?, ?, 'PEMBAYARAN DARI KASIR MOBILE', ?, 1)`,
        [
          idrecSetorDtl, // ID Unik baris detail
          nomorSetor,
          toSqlDateTime(header.tanggal),
          invNomor,
          bayarTransfer,
          angsurId, // ID Angsur (mengisi kekosongan yang menyebabkan duplicate entry '')
        ]
      );
    }

    await connection.commit();
    res.status(201).json({
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
                g.gdg_transferbank

            FROM tinv_hdr h
            LEFT JOIN tgudang g ON g.gdg_kode = h.inv_cab
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
                TRIM(CONCAT(b.brg_jeniskaos, " ", b.brg_tipe, " ", b.brg_lengan, " ", b.brg_jeniskain, " ", b.brg_warna)) AS nama_barang
            FROM tinv_dtl d
            LEFT JOIN tbarangdc b ON b.brg_kode = d.invd_kode
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

// 6. Send Receipt WA
const sendReceiptWa = async (req, res) => {
  try {
    const { nomor, hp } = req.body;

    // Reuse getPrintData logic or fetch internally
    // Disini kita format manual string WA-nya
    // (Anda bisa memanggil fungsi getPrintData internal jika mau, tapi query ulang lebih aman)

    // ... (Query data sama seperti getPrintData) ...
    // Agar singkat, saya asumsikan kita panggil ulang query sederhana
    const [rows] = await pool.query(
      `SELECT h.*, g.gdg_inv_nama FROM tinv_hdr h LEFT JOIN tgudang g ON g.gdg_kode = h.inv_cab WHERE inv_nomor = ?`,
      [nomor]
    );
    if (!rows.length)
      return res.status(404).json({ message: "Invoice not found" });
    const hdr = rows[0];

    const [dtl] = await pool.query(
      `SELECT d.*, b.brg_jeniskaos FROM tinv_dtl d LEFT JOIN tbarangdc b ON b.brg_kode = d.invd_kode WHERE invd_inv_nomor = ?`,
      [nomor]
    );

    let message = `*STRUK BELANJA - ${hdr.gdg_inv_nama}*\n`;
    message += `No: ${hdr.inv_nomor}\n`;
    message += `Tgl: ${format(new Date(hdr.inv_tanggal), "dd-MM-yyyy")}\n`;
    message += `--------------------------------\n`;

    let subTotal = 0;
    dtl.forEach((d) => {
      const total = d.invd_jumlah * (d.invd_harga - d.invd_diskon);
      subTotal += total;
      message += `${d.brg_jeniskaos} (${d.invd_ukuran})\n`;
      if (d.invd_diskon > 0) {
        message += `${d.invd_jumlah} x ${d.invd_harga} (Disc ${d.invd_diskon}) = ${total}\n`;
      } else {
        message += `${d.invd_jumlah} x ${d.invd_harga} = ${total}\n`;
      }
    });

    message += `--------------------------------\n`;
    message += `Total: Rp ${subTotal}\n`;
    if (hdr.inv_disc > 0) message += `Diskon: -Rp ${hdr.inv_disc}\n`;
    message += `*Grand Total: Rp ${subTotal - hdr.inv_disc}*\n`;
    message += `Bayar: Rp ${hdr.inv_bayar}\n`;
    message += `Kembali: Rp ${hdr.inv_kembali}\n`;
    message += `\nTerima kasih telah berbelanja!`;

    // Kirim via Service WA (Sesuaikan dengan service WA Anda)
    const whatsappService = require("../services/whatsapp.service");
    await whatsappService.sendMessage(hp, message); // Asumsi fungsi ini ada

    res
      .status(200)
      .json({ success: true, message: "Struk berhasil dikirim ke WhatsApp." });
  } catch (error) {
    console.error("Error sendReceiptWa:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  findProductByBarcode,
  getDefaultCustomer,
  savePenjualan,
  searchRekening,
  getActivePromos,
  getPrintData, // -> Baru
  sendReceiptWa, // -> Baru
};
