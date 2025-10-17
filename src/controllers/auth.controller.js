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

    // 2. Cari user di database
    const [rows] = await pool.query("SELECT * FROM tuser WHERE user_kode = ?", [
      user_kode,
    ]);

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Kode user atau password salah.", // Pesan disamarkan demi keamanan
      });
    }

    const user = rows[0];

    // if (user.user_kode === "LUTFI", "ADIN") {
    //   // Ganti dengan user kode yang benar
    //   user.user_cab = "KDC";
    // }

    const isPasswordMatch = user_password === user.user_password;

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: "Kode user atau password salah.",
      });
    }

    // 4. Jika password cocok, buat JSON Web Token (JWT)
    const payload = {
      kode: user.user_kode,
      nama: user.user_nama,
      cabang: user.user_cab,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "8h", // Token akan kedaluwarsa dalam 8 jam
    });

    // 5. Kirim respons sukses beserta token
    res.status(200).json({
      success: true,
      message: "Login berhasil!",
      data: {
        token: token,
        user: payload,
      },
    });
  } catch (error) {
    console.error("Terjadi error saat login:", error);
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server.",
    });
  }
};

module.exports = {
  login,
};
