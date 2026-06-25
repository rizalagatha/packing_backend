const pool = require("../config/database");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const challengeStore = new Map();

// Menghitung jarak antara dua koordinat (dalam meter) menggunakan Haversine formula
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Radius bumi dalam meter (6371 km)
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const deltaP = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaP / 2) * Math.sin(deltaP / 2) +
    Math.cos(p1) *
      Math.cos(p2) *
      Math.sin(deltaLon / 2) *
      Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Hasil dalam METER
};

// Fungsi ini akan dipanggil oleh 'login' dan 'selectBranch'
const generateFinalToken = (user, cabangNama) => {
  const payload = {
    kode: user.user_kode,
    nama: user.user_nama,
    cabang: user.user_cab,
    cabang_nama: cabangNama || user.user_cab,
    user_kodekasir: user.user_kodekasir || "000",
  };

  // --- LOGIKA EXPIRATION TOKEN KHUSUS ---
  let expiresIn = "12h"; // Default 12 Jam

  if (user.user_kode) {
    const userKodeUpper = user.user_kode.toUpperCase();

    if (userKodeUpper === "SETYO") {
      expiresIn = "365d"; // SETYO dapat 1 Tahun
    } else if (userKodeUpper === "HARIS") {
      expiresIn = "30d"; // HARIS tetap 30 Hari (sesuai kode lama Anda)
    }
  }

  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: expiresIn,
  });

  return { token, user: payload };
};

const login = async (req, res) => {
  try {
    // Tangkap latitude dan longitude dari body
    const {
      user_kode,
      user_password,
      source = "mobile",
      latitude,
      longitude,
    } = req.body;

    if (!user_kode || !user_password) {
      return res.status(400).json({
        success: false,
        message: "Kode user dan password harus diisi.",
      });
    }

    // 1. Ambil SEMUA baris yang cocok dengan user_kode
    const [userRows] = await pool.query(
      "SELECT * FROM tuser WHERE user_kode = ?",
      [user_kode],
    );
    if (userRows.length === 0) {
      return res
        .status(401)
        .json({ success: false, message: "User tidak ditemukan." });
    }

    // 2. Verifikasi password menggunakan baris pertama (password-nya sama untuk semua cabang)
    const firstUser = userRows[0];
    const passwordMatch = user_password === firstUser.user_password;

    if (!passwordMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Password salah." });
    }

    // 3. Cek jumlah cabang (jumlah baris)
    if (userRows.length > 1) {
      if (source === "web-cetak") {
        // Cari data user untuk cabang KDC atau KBS
        const webUser = userRows.find(
          (u) => u.user_cab === "KDC" || u.user_cab === "KBS",
        );
        const userToUse = webUser || firstUser; // Fallback

        const [gudangRows] = await pool.query(
          "SELECT gdg_nama FROM tgudang WHERE gdg_kode = ?",
          [userToUse.user_cab],
        );
        const cabangNama =
          gudangRows.length > 0 ? gudangRows[0].gdg_nama : userToUse.user_cab;

        const finalData = generateFinalToken(userToUse, cabangNama);
        return res.status(200).json({
          success: true,
          multiBranch: false,
          data: finalData,
        });
      }
      // --- KASUS MULTI CABANG ---
      const branchCodes = userRows.map((user) => user.user_cab);
      const [gudangRows] = await pool.query(
        "SELECT gdg_kode, gdg_nama FROM tgudang WHERE gdg_kode IN (?)",
        [branchCodes],
      );
      const branchMap = new Map(
        gudangRows.map((g) => [g.gdg_kode, g.gdg_nama]),
      );

      const detailedBranches = userRows.map((user) => ({
        kode: user.user_cab,
        nama: branchMap.get(user.user_cab) || user.user_cab,
      }));

      // Buat token sementara
      const preAuthPayload = {
        kode: firstUser.user_kode,
        nama: firstUser.user_nama,
      };
      const preAuthToken = jwt.sign(preAuthPayload, process.env.JWT_SECRET, {
        expiresIn: "5m",
      });

      res.status(200).json({
        success: true,
        multiBranch: true,
        preAuthToken: preAuthToken,
        branches: detailedBranches,
      });
    } else {
      // --- KASUS CABANG TUNGGAL ---
      const cabangKode = firstUser.user_cab;
      const [gudangRows] = await pool.query(
        "SELECT gdg_nama, gdg_dc, gdg_lat, gdg_long FROM tgudang WHERE gdg_kode = ?",
        [cabangKode],
      );

      const gudang = gudangRows.length > 0 ? gudangRows[0] : null;
      const cabangNama = gudang ? gudang.gdg_nama : cabangKode;

      // ==========================================
      // [GEOFENCING] Validasi Lokasi Jika Bukan DC
      // ==========================================
      if (source === "mobile" && gudang && gudang.gdg_dc === 0) {
        if (!latitude || !longitude) {
          return res.status(403).json({
            success: false,
            message:
              "Akses Ditolak. Harap izinkan dan hidupkan GPS Anda untuk login di toko ini.",
          });
        }

        const storeLat = parseFloat(gudang.gdg_lat);
        const storeLong = parseFloat(gudang.gdg_long);

        if (isNaN(storeLat) || isNaN(storeLong)) {
          return res.status(500).json({
            success: false,
            message:
              "Koordinat toko belum disetting di database. Hubungi Admin.",
          });
        }

        const distance = calculateDistance(
          latitude,
          longitude,
          storeLat,
          storeLong,
        );

        if (distance > 100) {
          // Toleransi 100 meter
          return res.status(403).json({
            success: false,
            message: `Akses Ditolak. Anda terdeteksi berada di luar jangkauan toko. Jarak Anda: ${Math.round(distance)} meter.`,
          });
        }
      }
      // ==========================================

      const finalData = generateFinalToken(firstUser, cabangNama);
      res.status(200).json({
        success: true,
        multiBranch: false,
        data: finalData,
      });
    }
  } catch (error) {
    console.error("Login error:", error);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server." });
  }
};

const enrollDevice = async (req, res) => {
  try {
    const { user_kode, user_password, device_id, public_key, device_name } =
      req.body;

    if (!user_kode || !user_password || !device_id || !public_key) {
      return res.status(400).json({
        success: false,
        message: "Data pendaftaran perangkat tidak lengkap.",
      });
    }

    // 1. Verifikasi Password Kasir
    const [userRows] = await pool.query(
      "SELECT user_password FROM tuser WHERE user_kode = ?",
      [user_kode],
    );
    if (userRows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "User tidak ditemukan." });

    if (userRows[0].user_password !== user_password) {
      return res
        .status(401)
        .json({ success: false, message: "Password salah." });
    }

    // 2. Simpan perangkat ke database (Otomatis statusnya PENDING)
    // Jika device_id sudah ada, kita update public_key-nya dan reset status ke PENDING
    await pool.query(
      `INSERT INTO tuser_device (device_id, user_kode, public_key, device_name, status, created_at) 
       VALUES (?, ?, ?, ?, 'PENDING', NOW()) 
       ON DUPLICATE KEY UPDATE public_key = ?, user_kode = ?, status = 'PENDING', created_at = NOW()`,
      [device_id, user_kode, public_key, device_name, public_key, user_kode],
    );

    res.status(200).json({
      success: true,
      message:
        "Perangkat berhasil didaftarkan. Menunggu persetujuan (Approval) dari Manager Pusat.",
    });
  } catch (error) {
    console.error("Enroll Device Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mendaftarkan perangkat." });
  }
};

const requestChallenge = async (req, res) => {
  try {
    const { user_kode, device_id } = req.body;

    // 1. Cek apakah perangkat sudah di-Approve
    const [deviceRows] = await pool.query(
      "SELECT status FROM tuser_device WHERE device_id = ? AND user_kode = ?",
      [device_id, user_kode],
    );

    if (deviceRows.length === 0) {
      return res.status(404).json({
        success: false,
        needsEnrollment: true,
        message: "Perangkat belum terdaftar.",
      });
    }
    if (deviceRows[0].status !== "APPROVED") {
      return res.status(403).json({
        success: false,
        message: `Perangkat belum disetujui (Status: ${deviceRows[0].status})`,
      });
    }

    // 2. Buat string acak (Challenge) sepanjang 32 bytes
    const challenge = crypto.randomBytes(32).toString("hex");

    // 3. Simpan di memori server dengan batas waktu 2 menit
    challengeStore.set(device_id, {
      challenge: challenge,
      expires: Date.now() + 120000, // 2 menit
    });

    res.status(200).json({ success: true, challenge: challenge });
  } catch (error) {
    console.error("Request Challenge Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat token keamanan." });
  }
};

const loginWithDevice = async (req, res) => {
  try {
    const { user_kode, device_id, signature, latitude, longitude } = req.body;

    if (!user_kode || !device_id || !signature) {
      return res
        .status(400)
        .json({ success: false, message: "Data login tidak lengkap." });
    }

    // 1. Ambil challenge dari memori (Cegah Replay Attack)
    const challengeData = challengeStore.get(device_id);
    if (!challengeData || challengeData.expires < Date.now()) {
      return res.status(401).json({
        success: false,
        message: "Sesi login expired. Silakan coba tekan Login lagi.",
      });
    }

    // 2. Ambil Public Key dari database
    const [deviceRows] = await pool.query(
      "SELECT public_key, status FROM tuser_device WHERE device_id = ? AND user_kode = ?",
      [device_id, user_kode],
    );

    if (deviceRows.length === 0 || deviceRows[0].status !== "APPROVED") {
      return res
        .status(403)
        .json({ success: false, message: "Akses perangkat ditolak." });
    }

    const rawKey = deviceRows[0].public_key;
    // Pecah string menjadi maksimal 64 karakter per baris (Standar PEM)
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${rawKey.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;

    // ==========================================
    // 3. VERIFIKASI TANDA TANGAN DIGITAL (KEYSTORE)
    // ==========================================
    const isVerified = crypto.verify(
      "SHA256",
      Buffer.from(challengeData.challenge),
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(signature, "base64"),
    );

    if (!isVerified) {
      return res
        .status(401)
        .json({ success: false, message: "Tanda tangan digital tidak valid!" });
    }

    // Hapus challenge yang sudah dipakai agar tidak bisa digunakan ulang (1x pakai)
    challengeStore.delete(device_id);

    // ==========================================
    // 4. LANJUTKAN LOGIKA GEOFENCING & GENERATE TOKEN
    // ==========================================
    const [userRows] = await pool.query(
      "SELECT * FROM tuser WHERE user_kode = ?",
      [user_kode],
    );
    const firstUser = userRows[0];

    // Jika MULTI CABANG (Abaikan GPS di tahap ini, pindah ke selectBranch)
    if (userRows.length > 1) {
      const branchCodes = userRows.map((user) => user.user_cab);
      const [gudangRows] = await pool.query(
        "SELECT gdg_kode, gdg_nama FROM tgudang WHERE gdg_kode IN (?)",
        [branchCodes],
      );
      const branchMap = new Map(
        gudangRows.map((g) => [g.gdg_kode, g.gdg_nama]),
      );

      const detailedBranches = userRows.map((user) => ({
        kode: user.user_cab,
        nama: branchMap.get(user.user_cab) || user.user_cab,
      }));

      const preAuthPayload = {
        kode: firstUser.user_kode,
        nama: firstUser.user_nama,
      };
      const preAuthToken = jwt.sign(preAuthPayload, process.env.JWT_SECRET, {
        expiresIn: "5m",
      });

      return res.status(200).json({
        success: true,
        multiBranch: true,
        preAuthToken: preAuthToken,
        branches: detailedBranches,
      });
    } else {
      // Jika CABANG TUNGGAL (Eksekusi GPS Geofencing)
      const cabangKode = firstUser.user_cab;
      const [gudangRows] = await pool.query(
        "SELECT gdg_nama, gdg_dc, gdg_lat, gdg_long FROM tgudang WHERE gdg_kode = ?",
        [cabangKode],
      );
      const gudang = gudangRows.length > 0 ? gudangRows[0] : null;
      const cabangNama = gudang ? gudang.gdg_nama : cabangKode;

      // Logika GPS (Sama persis seperti yang kita buat)
      if (gudang && gudang.gdg_dc === 0) {
        if (!latitude || !longitude) {
          return res.status(403).json({
            success: false,
            message: "Akses Ditolak. Harap izinkan GPS.",
          });
        }
        const storeLat = parseFloat(gudang.gdg_lat);
        const storeLong = parseFloat(gudang.gdg_long);
        if (isNaN(storeLat) || isNaN(storeLong)) {
          return res.status(500).json({
            success: false,
            message: "Koordinat toko belum disetting.",
          });
        }

        const distance = calculateDistance(
          latitude,
          longitude,
          storeLat,
          storeLong,
        );
        if (distance > 100) {
          return res.status(403).json({
            success: false,
            message: `Akses Ditolak. Jarak Anda: ${Math.round(distance)} meter.`,
          });
        }
      }

      const finalData = generateFinalToken(firstUser, cabangNama);
      res
        .status(200)
        .json({ success: true, multiBranch: false, data: finalData });
    }
  } catch (error) {
    console.error("Login with Device Error:", error);
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada verifikasi keamanan.",
    });
  }
};

const selectBranch = async (req, res) => {
  try {
    // Tangkap latitude dan longitude
    const { branchCode, preAuthToken, latitude, longitude } = req.body;

    const decoded = jwt.verify(preAuthToken, process.env.JWT_SECRET);

    const [userRows] = await pool.query(
      "SELECT * FROM tuser WHERE user_kode = ? AND user_cab = ?",
      [decoded.kode, branchCode],
    );

    if (userRows.length === 0) {
      throw new Error("Gagal memvalidasi user dengan cabang yang dipilih.");
    }

    const firstUser = userRows[0];

    const [gudangRows] = await pool.query(
      "SELECT gdg_nama, gdg_dc, gdg_lat, gdg_long FROM tgudang WHERE gdg_kode = ?",
      [branchCode],
    );
    const gudang = gudangRows.length > 0 ? gudangRows[0] : null;

    // ==========================================
    // [GEOFENCING] Validasi Lokasi Jika Bukan DC
    // ==========================================
    if (gudang && gudang.gdg_dc === 0) {
      if (!latitude || !longitude) {
        return res.status(403).json({
          success: false,
          message:
            "Akses Ditolak. Harap izinkan dan hidupkan GPS Anda untuk masuk ke toko ini.",
        });
      }

      const storeLat = parseFloat(gudang.gdg_lat);
      const storeLong = parseFloat(gudang.gdg_long);

      if (isNaN(storeLat) || isNaN(storeLong)) {
        return res.status(500).json({
          success: false,
          message: "Koordinat toko belum disetting di database. Hubungi Admin.",
        });
      }

      const distance = calculateDistance(
        latitude,
        longitude,
        storeLat,
        storeLong,
      );

      if (distance > 100) {
        // Toleransi 100 meter
        return res.status(403).json({
          success: false,
          message: `Akses Ditolak. Anda terdeteksi berada di luar jangkauan toko. Jarak Anda: ${Math.round(distance)} meter.`,
        });
      }
    }
    // ==========================================

    const cabangNama = gudang ? gudang.gdg_nama : branchCode;
    const finalData = generateFinalToken(firstUser, cabangNama);

    res.status(200).json({ success: true, data: finalData });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Sesi pemilihan cabang kedaluwarsa.",
      });
    }
    res.status(500).json({
      success: false,
      message: error.message || "Gagal memfinalisasi sesi.",
    });
  }
};

const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;

    // [FIX 1] Ambil 'kode' dari token, bukan 'id'
    // Sesuai dengan payload di generateFinalToken
    const userKode = req.user.kode;

    if (!fcmToken) {
      return res.status(400).json({ message: "Token FCM wajib diisi" });
    }

    // [FIX 2] Gunakan kolom 'user_kode' di WHERE clause (bukan user_id)
    // Asumsi primary key di tabel tuser adalah user_kode
    await pool.query(
      `UPDATE tuser SET user_fcm_token = ? WHERE user_kode = ?`,
      [fcmToken, userKode],
    );

    res.json({ message: "FCM Token berhasil diupdate" });
  } catch (error) {
    console.error("Error updateFcmToken:", error); // Tambah log biar jelas kalau ada error lain
    res.status(500).json({ message: "Gagal update token" });
  }
};

const logout = async (req, res) => {
  try {
    const userKode = req.user.kode;
    // Hapus token di database agar notifikasi tidak masuk lagi
    await pool.query(
      "UPDATE tuser SET user_fcm_token = NULL WHERE user_kode = ?",
      [userKode],
    );
    res.status(200).json({ success: true, message: "Token berhasil dihapus." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal logout." });
  }
};

module.exports = {
  login,
  selectBranch,
  updateFcmToken,
  logout,
  enrollDevice,
  requestChallenge,
  loginWithDevice,
};
