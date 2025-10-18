const pool = require("../config/database");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

/**
 * Logika untuk login user
 */
const login = async (req, res) => {
  try {
    const { user_kode, user_password } = req.body;

    // 1. Validasi input
    if (!user_kode || !user_password) {
      return res.status(400).json({
        success: false,
        message: "Kode user dan password harus diisi.",
      });
    }

    const [userRows] = await pool.query(
      "SELECT * FROM tuser WHERE user_kode = ?",
      [user_kode]
    );
    if (userRows.length === 0) {
      return res
        .status(401)
        .json({ success: false, message: "User tidak ditemukan." });
    }
    const user = userRows[0];

    // Verifikasi password
    const passwordMatch = await bcrypt.compare(
      user_password,
      user.user_password
    );
    if (!passwordMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Password salah." });
    }

    // Query untuk mengambil SEMUA cabang yang dimiliki user
    // ASUMSI: Anda punya tabel `tuser_cabang` dengan kolom `user_kode` dan `cabang_kode`
    const [branchRows] = await pool.query(
      `SELECT c.cabang_kode as kode, g.gdg_nama as nama 
         FROM tuser_cabang c
         LEFT JOIN tgudang g ON c.cabang_kode = g.gdg_kode
         WHERE c.user_kode = ?`,
      [user.user_kode]
    );

    if (branchRows.length > 1) {
      // --- KASUS MULTI CABANG ---
      const preAuthPayload = { kode: user.user_kode, nama: user.user_nama };
      const preAuthToken = jwt.sign(preAuthPayload, process.env.JWT_SECRET, {
        expiresIn: "5m",
      });

      res.status(200).json({
        success: true,
        multiBranch: true,
        preAuthToken: preAuthToken,
        branches: branchRows,
      });
    } else {
      // --- KASUS CABANG TUNGGAL (ATAU DARI tuser) ---
      const finalBranch =
        branchRows.length === 1 ? branchRows[0].kode : user.user_cab;
      const payload = {
        kode: user.user_kode,
        nama: user.user_nama,
        cabang: finalBranch,
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "8h",
      });

      res.status(200).json({
        success: true,
        multiBranch: false,
        data: { token, user: payload },
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

    // Verifikasi token sementara
    const decoded = jwt.verify(preAuthToken, process.env.JWT_SECRET);

    // Buat token final dengan cabang yang dipilih
    const payload = {
      kode: decoded.kode,
      nama: decoded.nama,
      cabang: branchCode,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "8h",
    });

    res.status(200).json({
      success: true,
      data: { token, user: payload },
    });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({
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
