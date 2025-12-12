const pool = require("../config/database");
const { format } = require("date-fns");

// --- Helper Functions ---
const toSqlDate = (date) => format(new Date(date), "yyyy-MM-dd");
const toSqlDateTime = (date) => format(new Date(date), "yyyy-MM-dd HH:mm:ss");
const applyRounding = (num) => Math.round(num); // Sederhana

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

// 1. Cari Produk by Barcode (Dengan info Harga Bertingkat)
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
                d.brgd_harga AS harga,   -- Harga Level 1
                d.brgd_hrg2 AS harga2,   -- Harga Level 2
                d.brgd_hrg3 AS harga3,   -- Harga Level 3 / 5
                d.brgd_hrg4 AS harga4,   -- Harga Level 4
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

// 2. Get Default Customer (RETAIL)
const getDefaultCustomer = async (req, res) => {
  try {
    const { cabang } = req.user;
    // --- PERBAIKAN: Gunakan ALIAS (AS kode, AS nama) ---
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

// 3. Simpan Penjualan (Simplified Version of Invoice Controller)
const savePenjualan = async (req, res) => {
  const { header, items, payment, totals } = req.body;
  const user = req.user;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // --- A. Generate Nomor ---
    const invNomor = await generateNewInvNumber(user.cabang, header.tanggal);
    const idrec = `${user.cabang}INV${format(new Date(), "yyyyMMddHHmmssSSS")}`;
    const piutangNomor = `${header.customer.kode}${invNomor}`;

    // --- B. Hitung Values ---
    const subTotal = applyRounding(totals.subTotal);
    const totalDiskon = applyRounding(totals.totalDiskonFaktur || 0);
    const grandTotal = applyRounding(totals.grandTotal);

    // Pembayaran
    const bayarTunai = applyRounding(Number(payment.tunai || 0));
    const bayarTransfer = applyRounding(Number(payment.transfer?.nominal || 0));
    const totalBayar = bayarTunai + bayarTransfer; // Anggap mobile cuma support Tunai & Transfer dulu

    // Kembalian
    const kembalian = Math.max(totalBayar - grandTotal, 0);

    // Piutang (Jika ada sisa)
    const sisaPiutang = Math.max(grandTotal - totalBayar, 0);

    // --- C. Insert Header (tinv_hdr) ---
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
        header.customer.kode,
        header.customer.level_kode || "1",
        header.keterangan || "Mobile Sales",
        user.kode,
        totalDiskon,
        0, // Biaya kirim 0 dulu
        totalBayar,
        bayarTunai,
        bayarTransfer,
        kembalian,
        user.kode,
      ]
    );

    // --- D. Insert Detail (tinv_dtl) ---
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
        item.jumlah, // mstpesan=0, mststok=jumlah (karena stok fisik langsung)
        harga,
        0,
        0,
        diskonRp, // hpp=0 (biar backend lain yg handle), disc%=0
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

    // --- E. Insert Piutang (tpiutang_hdr & dtl) ---
    // Mekanismenya: Buat piutang full dulu, lalu bayar lunas/sebagian di detail
    if (grandTotal > 0) {
      await connection.query(
        `INSERT INTO tpiutang_hdr (ph_nomor, ph_tanggal, ph_cus_kode, ph_inv_nomor, ph_top, ph_nominal) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          piutangNomor,
          toSqlDate(header.tanggal),
          header.customer.kode,
          invNomor,
          0,
          sisaPiutang,
        ]
      );

      // Detail 1: Tagihan (Debet)
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

      // Detail 2: Pembayaran Tunai (Kredit)
      if (bayarTunai > 0) {
        // Di sistem ini tunai bersih (setelah kembalian) yang dicatat sebagai pengurang piutang
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

      // Detail 3: Pembayaran Transfer (Kredit)
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

    // --- F. Insert Setoran (Jika Transfer) ---
    if (bayarTransfer > 0) {
      const nomorSetor = await generateNewSetorNumber(
        connection,
        user.cabang,
        header.tanggal
      );
      const idrecSetor = `${user.cabang}SH${format(
        new Date(),
        "yyyyMMddHHmmssSSS"
      )}`;

      // Header Setoran
      await connection.query(
        `INSERT INTO tsetor_hdr (sh_idrec, sh_nomor, sh_cus_kode, sh_tanggal, sh_jenis, sh_nominal, sh_otomatis, user_create, date_create) VALUES (?, ?, ?, ?, 1, ?, 'Y', ?, NOW())`,
        [
          idrecSetor,
          nomorSetor,
          header.customer.kode,
          toSqlDateTime(header.tanggal),
          bayarTransfer,
          user.kode,
        ]
      );

      // Detail Setoran
      await connection.query(
        `INSERT INTO tsetor_dtl (sd_idrec, sd_sh_nomor, sd_tanggal, sd_inv, sd_bayar, sd_ket, sd_nourut) VALUES (?, ?, ?, ?, ?, 'PEMBAYARAN DARI KASIR MOBILE', 1)`,
        [
          idrecSetor,
          nomorSetor,
          toSqlDateTime(header.tanggal),
          invNomor,
          bayarTransfer,
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

// 4. Search Rekening (Untuk Transfer)
const searchRekening = async (req, res) => {
  try {
    const { term } = req.query;
    const { cabang } = req.user; // Ambil cabang dari user login
    const searchTerm = `%${term || ""}%`;

    // Pastikan database 'finance' bisa diakses oleh user DB Anda
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

    // Filter rek_kaosan menggunakan %CABANG%
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

module.exports = {
  findProductByBarcode,
  getDefaultCustomer,
  savePenjualan,
  searchRekening, // -> Tambahkan export ini
};
