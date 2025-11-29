// 1. Impor library yang dibutuhkan
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require("express");
const cors = require("cors");
const whatsappService = require('./src/services/whatsapp.service');

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

const returAdminRoutes = require("./src/routes/returAdmin.routes.js");
app.use("/api/retur-admin", returAdminRoutes);

const spkRoutes = require('./src/routes/spk.routes.js');
app.use('/api/spk', spkRoutes);

const whatsappRoutes = require('./src/routes/whatsapp.routes.js');
app.use('/api/whatsapp', whatsappRoutes);

const checkerRoutes = require('./src/routes/checker.routes.js');
app.use('/api/checker', checkerRoutes);

const mutasiStoreRoutes = require('./src/routes/mutasiStore.routes.js');
app.use('/api/mutasi-store', mutasiStoreRoutes);

const mutasiTerimaRoutes = require('./src/routes/mutasiTerima.routes.js');
app.use('/api/mutasi-terima', mutasiTerimaRoutes);

const stockRoutes = require('./src/routes/stock.routes.js');
app.use('/api/stock', stockRoutes);

// 7. Menjalankan Server
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});