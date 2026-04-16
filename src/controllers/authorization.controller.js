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

      // (Di dalam block try FCM createRequest)
      if (
        o_jenis === "AMBIL_BARANG" &&
        o_cab_tujuan &&
        o_cab_tujuan !== "KDC"
      ) {
        const targetTopic = `approval_${o_cab_tujuan}`;
        await fcmService.sendToTopic(targetTopic, title, body, dataPayload);
      } else if (String(o_jenis).trim() === "TRANSFER_SOP") {
        const targetTopic = `user_RIO`; // Asumsi ada topic/token untuk Rio
        await fcmService.sendToTopic(targetTopic, title, body, dataPayload);
      } else {
        // --- LOGIKA KIRIM KE MANAGER ---
        const today = new Date();
        const isEstuManagerPeriod =
          today >= new Date(2026, 0, 12) && today < new Date(2026, 0, 17);
        const isPeminjaman = String(o_jenis).trim() === "PEMINJAMAN_BARANG";
        const isKlaimPettyCash = String(o_jenis).trim() === "KLAIM_PETTYCASH"; // [TAMBAH INI]

        let managerCodes = ["DARUL"]; // Darul selalu dikirim

        if (isPeminjaman || isKlaimPettyCash) {
          if (!managerCodes.includes("ESTU")) managerCodes.push("ESTU");
        }

        if (isEstuManagerPeriod) {
          if (!managerCodes.includes("ESTU")) managerCodes.push("ESTU");
        } else {
          // HARIS TIDAK MENDAPATKAN PEMINJAMAN & KLAIM PETTY CASH
          if (!isPeminjaman && !isKlaimPettyCash) {
            managerCodes.push("HARIS");
          }
        }

        const [managers] = await pool.query(
          `SELECT DISTINCT user_fcm_token FROM tuser WHERE user_kode IN (?) AND user_fcm_token IS NOT NULL AND user_fcm_token != ''`,
          [managerCodes],
        );

        if (managers.length > 0) {
          const sendPromises = managers.map((mgr) =>
            fcmService.sendNotification(
              mgr.user_fcm_token,
              title,
              body,
              dataPayload,
            ),
          );
          await Promise.all(sendPromises);
        }
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

// 3. [MANAGER] List pending requests
const getPendingRequests = async (req, res) => {
  try {
    const user = req.user;
    const userKodeUpper = String(user.kode).toUpperCase();
    const today = new Date();
    const isEstuManagerPeriod =
      today >= new Date(2026, 0, 12) && today < new Date(2026, 0, 17);

    // [PERBAIKAN]: Base Query
    let query = "SELECT * FROM totorisasi WHERE o_status = 'P' ";
    let params = [];

    if (user.cabang === "KDC") {
      // LOGIKA UNTUK ORANG-ORANG PUSAT (KDC)

      if (userKodeUpper === "ESTU") {
        if (isEstuManagerPeriod) {
          // Estu jadi Manager Sementara (Lihat semua transaksi KDC + Hak miliknya)
          query +=
            " AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC' OR o_jenis IN ('PEMINJAMAN_BARANG', 'KLAIM_PETTYCASH', 'SUBMIT_BAP'))";
        } else {
          // Estu Mode Normal (Hanya lihat hak miliknya)
          query +=
            " AND o_jenis IN ('PEMINJAMAN_BARANG', 'KLAIM_PETTYCASH', 'SUBMIT_BAP')";
        }
      } else if (userKodeUpper === "HARIS") {
        if (isEstuManagerPeriod) {
          // Haris Libur
          query += " AND 1=0";
        } else {
          // Haris Mode Normal (Kecualikan milik Estu dan Rio)
          query +=
            " AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC') AND o_jenis NOT IN ('PEMINJAMAN_BARANG', 'KLAIM_PETTYCASH', 'SUBMIT_BAP', 'TRANSFER_SOP')";
        }
      } else if (userKodeUpper === "RIO") {
        // Rio hanya lihat Transfer SOP
        query += " AND o_jenis = 'TRANSFER_SOP'";
      } else {
        // Manager KDC lainnya (Darul dll) - Lihat semua KDC
        query += " AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC')";
      }
    } else {
      // LOGIKA UNTUK ORANG TOKO (Misal: K01 minta ke K02)
      query +=
        " AND (o_target = ? OR (o_cab = ? AND (o_target IS NULL OR o_target = '')))";
      params.push(user.cabang, user.cabang);
    }

    query += " ORDER BY o_created DESC";

    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows || [] });
  } catch (error) {
    console.error("Error getPendingRequests:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat data otorisasi." });
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
      [authNomor],
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
      const isKlaimPettyCash = o_jenis === "KLAIM_PETTYCASH";
      const isSubmitBap = o_jenis === "SUBMIT_BAP"; // [TAMBAH INI]

      // Estu boleh approve jika itu PEMINJAMAN_BARANG, KLAIM_PETTYCASH, atau SUBMIT_BAP
      // ATAU jika sedang masuk periode manager (12-16 Jan)
      if (
        !isPeminjaman &&
        !isKlaimPettyCash &&
        !isSubmitBap &&
        !isEstuManagerPeriod
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Anda hanya berwenang untuk otorisasi Peminjaman Barang, Klaim Petty Cash, dan BAP di luar periode 12-16 Jan.",
        });
      }
    }

    // C. Proteksi RIO & Transfer SOP
    if (o_jenis === "TRANSFER_SOP" && userKodeUpper !== "RIO") {
      return res.status(403).json({
        success: false,
        message: "Otorisasi Transfer SOP hanya boleh dilakukan oleh RIO.",
      });
    }

    // Tambahan: Pastikan Rio tidak bisa approve yang bukan haknya
    if (userKodeUpper === "RIO" && o_jenis !== "TRANSFER_SOP") {
      return res.status(403).json({
        success: false,
        message: "Anda hanya berwenang untuk otorisasi Transfer SOP.",
      });
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

    // =========================================================================
    // [BARU] HOOK UNTUK MENG-ACC PETTY CASH SECARA OTOMATIS (DIRECT SQL)
    // =========================================================================
    const [authData] = await pool.query(
      "SELECT o_transaksi, o_jenis FROM totorisasi WHERE o_nomor = ?",
      [authNomor],
    );

    if (authData.length > 0) {
      const { o_transaksi, o_jenis } = authData[0];

      // Jika ini adalah Otorisasi Petty Cash (Klaim Kolektif)
      if (o_jenis === "KLAIM_PETTYCASH" && o_transaksi) {
        if (action === "APPROVE") {
          // 1. Update Header PCK menjadi ACC
          await pool.query(
            `UPDATE tpettycash_klaim_hdr 
                     SET pck_status = 'ACC', pck_acc = ?, date_acc = NOW(), user_modified = ?, date_modified = NOW() 
                     WHERE pck_nomor = ? AND pck_status = 'SUBMITTED'`,
            [approverName, approverName, o_transaksi],
          );

          // 2. Update Detail PC menjadi ACC
          await pool.query(
            `UPDATE tpettycash_hdr 
                     SET pc_status = 'ACC', user_modified = ?, date_modified = NOW() 
                     WHERE pck_nomor = ?`,
            [approverName, o_transaksi],
          );
        } else if (action === "REJECT") {
          const alasan = "Ditolak via Aplikasi HP";

          // 1. Update Header PCK menjadi REJECTED
          await pool.query(
            `UPDATE tpettycash_klaim_hdr 
                     SET pck_status = 'REJECTED', pck_keterangan = CONCAT(IFNULL(pck_keterangan, ''), '\n[Catatan Revisi]: ', ?), user_modified = ?, date_modified = NOW() 
                     WHERE pck_nomor = ? AND pck_status = 'SUBMITTED'`,
            [alasan, approverName, o_transaksi],
          );

          // 2. Update Detail PC menjadi REJECTED (Agar Kasir bisa edit ulang)
          await pool.query(
            `UPDATE tpettycash_hdr 
                     SET pc_status = 'REJECTED', user_modified = ?, date_modified = NOW() 
                     WHERE pck_nomor = ?`,
            [approverName, o_transaksi],
          );
        }
      }
    }
    // =========================================================================

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
