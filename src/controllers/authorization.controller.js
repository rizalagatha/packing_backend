const pool = require("../config/database");
const { format } = require("date-fns");
const fcmService = require("../services/fcm.service"); // Pastikan path ini benar

// --- HELPER INTERNAL ---
const generateAuthNumber = async (cabang) => {
  const date = new Date();
  const yyMM = format(date, "yyMM");
  const prefix = `${cabang}.AUTH.${yyMM}.`;

  const query = `
        SELECT o_nomor 
        FROM totorisasi 
        WHERE o_nomor LIKE ? 
        ORDER BY o_nomor DESC 
        LIMIT 1
    `;

  const [rows] = await pool.query(query, [`${prefix}%`]);

  let sequence = 1;
  if (rows.length > 0) {
    const lastNomor = rows[0].o_nomor;
    const lastSeqString = lastNomor.split(".").pop();
    const lastSeq = parseInt(lastSeqString, 10);
    if (!isNaN(lastSeq)) sequence = lastSeq + 1;
  }

  return `${prefix}${sequence.toString().padStart(4, "0")}`;
};

// --- CONTROLLER FUNCTIONS ---

// 1. [REQUESTER] Membuat permintaan otorisasi baru
const createRequest = async (req, res) => {
  try {
    // Ambil data sesuai key yang dikirim Frontend (o_jenis, o_nominal, dll)
    const { o_transaksi, o_jenis, o_ket, o_nominal, o_barcode, o_cab_tujuan } =
      req.body;

    // Cabang asal diambil dari user yang sedang login (KDC)
    const cabangAsal = req.user.cabang;
    const userRequester = req.user.kode;

    if (!cabangAsal) {
      return res
        .status(400)
        .json({ success: false, message: "Cabang user tidak terdeteksi." });
    }

    // 1. Generate Nomor menggunakan cabangAsal (KDC)
    // Ini akan menghasilkan 'KDC.AUTH.2601.0001' (19 karakter) - AMAN
    const authNomor = await generateAuthNumber(cabangAsal);

    const query = `
            INSERT INTO totorisasi 
            (o_nomor, o_transaksi, o_jenis, o_ket, o_nominal, o_cab, o_status, o_requester, o_created, o_pin, o_barcode, o_target)
            VALUES (?, ?, ?, ?, ?, ?, 'P', ?, NOW(), '-', ?, ?)
        `;

    await pool.query(query, [
      authNomor,
      o_transaksi || "NEW_TRX",
      o_jenis,
      o_ket,
      o_nominal || 0,
      cabangAsal, // o_cab (Asal)
      userRequester,
      o_barcode || "",
      o_cab_tujuan || null, // o_target (Tujuan: K01)
    ]);

    // 2. Logika Notifikasi FCM (Tetap sama)
    try {
      const title = `Permintaan Otorisasi: ${o_jenis.replace(/_/g, " ")}`;
      const body = `Req: ${userRequester} (Dari: ${cabangAsal})\nKet: ${
        o_ket.split("\n")[0]
      }`;

      const dataPayload = {
        jenis: String(o_jenis),
        nominal: String(o_nominal),
        transaksi: String(o_transaksi || ""),
        authId: String(authNomor),
      };

      if (
        o_jenis === "AMBIL_BARANG" &&
        o_cab_tujuan &&
        o_cab_tujuan !== "KDC"
      ) {
        const targetTopic = `approval_${o_cab_tujuan}`;
        await fcmService.sendToTopic(targetTopic, title, body, dataPayload);
      } else {
        // ... logika kirim ke manager (Haris/Darul)
      }
    } catch (fcmError) {
      console.error("[FCM Error] Ignored:", fcmError.message);
    }

    res.status(201).json({
      success: true,
      message: "Permintaan otorisasi terkirim.",
      authNomor,
    });
  } catch (error) {
    console.error("Error createRequest:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal membuat permintaan otorisasi." });
  }
};

// 2. [REQUESTER] Cek status otorisasi (Polling dari HP)
const checkStatus = async (req, res) => {
  try {
    const { authNomor } = req.params;
    const query = `SELECT o_status, o_approver FROM totorisasi WHERE o_nomor = ?`;
    const [rows] = await pool.query(query, [authNomor]);

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Data tidak ditemukan." });
    }

    const data = rows[0];
    res.status(200).json({
      success: true,
      status:
        data.o_status === "Y"
          ? "ACC"
          : data.o_status === "N"
          ? "TOLAK"
          : "WAIT",
      approver: data.o_approver,
    });
  } catch (error) {
    console.error("Error checkStatus:", error);
    res.status(500).json({ success: false, message: "Gagal mengecek status." });
  }
};

// 3. [MANAGER] List pending requests (Sudah ada di kode Anda)
const getPendingRequests = async (req, res) => {
  try {
    const user = req.user;
    const userKodeUpper = String(user.kode).toUpperCase();
    const today = new Date();
    const isEstuManagerPeriod =
      today >= new Date(2026, 0, 12) && today < new Date(2026, 0, 17);

    let query = "SELECT * FROM totorisasi WHERE o_status = 'P' ";
    let params = [];

    if (user.cabang === "KDC") {
      if (userKodeUpper === "ESTU") {
        query += isEstuManagerPeriod
          ? "AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC' OR o_jenis = 'PEMINJAMAN_BARANG')"
          : "AND o_jenis = 'PEMINJAMAN_BARANG'";
      } else if (userKodeUpper === "HARIS") {
        query += isEstuManagerPeriod
          ? "AND 1=0"
          : "AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC')";
      } else {
        query +=
          "AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC' OR o_jenis = 'PEMINJAMAN_BARANG')";
      }
    } else {
      query +=
        "AND (o_target = ? OR (o_cab = ? AND (o_target IS NULL OR o_target = '')))";
      params.push(user.cabang, user.cabang);
    }

    query += " ORDER BY o_created DESC";
    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal memuat data." });
  }
};

// [MANAGER/STORE] Melakukan Approve atau Reject
const processRequest = async (req, res) => {
  const { authNomor, action } = req.body;
  const user = req.user;

  if (!authNomor || !["APPROVE", "REJECT"].includes(action)) {
    return res.status(400).json({
      success: false,
      message: "Data proses tidak valid (Nomor atau Action salah).",
    });
  }

  try {
    // 1. AMBIL DETAIL JENIS REQUEST DULU
    const [checkRows] = await pool.query(
      "SELECT o_jenis FROM totorisasi WHERE o_nomor = ?",
      [authNomor]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data otorisasi tidak ditemukan.",
      });
    }

    const o_jenis = checkRows[0].o_jenis;
    const userKodeUpper = String(user.kode).toUpperCase();
    const today = new Date();

    // Periode Pengalihan: 12 Jan s/d 16 Jan 2026
    const isEstuManagerPeriod =
      today >= new Date(2026, 0, 12) && today < new Date(2026, 0, 17);

    // 2. VALIDASI KEAMANAN BERDASARKAN ROLE & TANGGAL

    // A. Proteksi HARIS: Dilarang approve apapun selama periode 12-16 Jan
    if (isEstuManagerPeriod && userKodeUpper === "HARIS") {
      return res.status(403).json({
        success: false,
        message:
          "Hak otorisasi Manager sedang dialihkan ke ESTU hingga 16 Jan 2026.",
      });
    }

    // B. Proteksi ESTU:
    if (userKodeUpper === "ESTU") {
      const isPeminjaman = o_jenis === "PEMINJAMAN_BARANG";

      // Estu hanya boleh approve jika itu PEMINJAMAN_BARANG
      // ATAU jika sedang masuk periode manager (12-16 Jan)
      if (!isPeminjaman && !isEstuManagerPeriod) {
        return res.status(403).json({
          success: false,
          message:
            "Anda hanya berwenang untuk otorisasi Peminjaman Barang di luar periode 12-16 Jan.",
        });
      }
    }

    // 3. EKSEKUSI UPDATE KE DATABASE
    const newStatus = action === "APPROVE" ? "Y" : "N";
    const approverName = user.kode || user.nama;

    const query = `
        UPDATE totorisasi 
        SET o_status = ?, o_approver = ?, o_approved_at = NOW()
        WHERE o_nomor = ? AND o_status = 'P'
    `;

    const [result] = await pool.query(query, [
      newStatus,
      approverName,
      authNomor,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Gagal memproses. Request mungkin sudah diproses oleh manager lain.",
      });
    }

    res.status(200).json({
      success: true,
      message: `Otorisasi berhasil di-${
        action === "APPROVE" ? "setujui" : "tolak"
      }.`,
    });
  } catch (error) {
    console.error("Error processRequest:", error);
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat memproses otorisasi.",
    });
  }
};

module.exports = {
  createRequest,
  checkStatus,
  getPendingRequests,
  processRequest,
};