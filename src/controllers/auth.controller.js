const pool = require("../config/database");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// Fungsi ini akan dipanggil oleh 'login' dan 'selectBranch'
const generateFinalToken = (user) => {
  const payload = {
    kode: user.user_kode,
    nama: user.user_nama,
    cabang: user.user_cab,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "8h" });
  return { token, user: payload };
};

const login = async (req, res) => {
  try {
    const { user_kode, user_password, source = "mobile" } = req.body;
    if (!user_kode || !user_password) {
      return res.status(400).json({
        success: false,
        message: "Kode user dan password harus diisi.",
      });
    }

    // 1. Ambil SEMUA baris yang cocok dengan user_kode
    const [userRows] = await pool.query(
      "SELECT * FROM tuser WHERE user_kode = ?",
      [user_kode]
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
          (u) => u.user_cab === "KDC" || u.user_cab === "KBS"
        );
        const userToUse = webUser || firstUser; // Fallback

        const finalData = generateFinalToken(userToUse);
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
        [branchCodes]
      );
      const branchMap = new Map(
        gudangRows.map((g) => [g.gdg_kode, g.gdg_nama])
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
      const finalData = generateFinalToken(firstUser);
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

const selectBranch = async (req, res) => {
  try {
    const { branchCode, preAuthToken } = req.body;

    const decoded = jwt.verify(preAuthToken, process.env.JWT_SECRET);

    // Ambil data user spesifik untuk cabang yang dipilih
    const [userRows] = await pool.query(
      "SELECT * FROM tuser WHERE user_kode = ? AND user_cab = ?",
      [decoded.kode, branchCode]
    );

    if (userRows.length === 0) {
      throw new Error("Gagal memvalidasi user dengan cabang yang dipilih.");
    }

    const finalData = generateFinalToken(userRows[0]);
    res.status(200).json({ success: true, data: finalData });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Sesi pemilihan cabang kedaluwarsa.",
      });
    }
    res
      .status(500)
      .json({ success: false, message: "Gagal memfinalisasi sesi." });
  }
};

module.exports = {
  login,
  selectBranch,
};
