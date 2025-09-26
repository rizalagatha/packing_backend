// 1. Impor library yang dibutuhkan
require("dotenv").config();
const express = require("express");
const cors = require("cors");

// 2. Inisialisasi koneksi database
// Cukup dengan memanggil file ini, koneksi akan dibuat dan diuji
require("./src/config/database");

// 3. Inisialisasi aplikasi Express
const app = express();

// 4. Pengaturan Middleware
app.use(cors()); // Mengizinkan akses dari domain lain (Cross-Origin Resource Sharing)
app.use(express.json()); // Mengizinkan server membaca body request dalam format JSON
app.use(express.urlencoded({ extended: true })); // Mengizinkan server membaca body dari form HTML

// 5. Rute Dasar (untuk tes)
app.get("/", (req, res) => {
  res.send("🎉 Selamat Datang di API Aplikasi Packing!");
});

// 6. Kumpulan Rute API Anda
// ====================================================================
// PENTING: Setiap kali Anda membuat file rute baru di folder src/api/,
// daftarkan di bawah ini agar bisa diakses oleh aplikasi.
// ====================================================================

const authRoutes = require("./src/routes/auth.routes.js");
app.use("/api/auth", authRoutes);

const packingRoutes = require("./src/routes/packing.routes.js");
app.use("/api/packing", packingRoutes);

const produkRoutes = require("./src/routes/produk.routes.js");
app.use("/api/produk", produkRoutes);

const suratJalanRoutes = require("./src/routes/suratJalan.routes.js");
app.use("/api/surat-jalan", suratJalanRoutes);

const terimaSjRoutes = require("./src/routes/terimaSj.routes.js");
app.use("/api/terima-sj", terimaSjRoutes);

// 7. Menjalankan Server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
