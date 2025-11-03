const mysql = require('mysql2/promise');
require('dotenv').config();

// Membuat koneksi pool ke database.
// Connection pool lebih efisien karena akan mengelola beberapa koneksi
// yang bisa dipakai ulang, daripada membuat koneksi baru setiap kali ada query.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Fungsi sederhana untuk menguji koneksi
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Koneksi ke database berhasil!');
    connection.release(); // Melepaskan koneksi kembali ke pool
  } catch (error) {
    console.error('❌ Gagal terkoneksi ke database:', error.message);
  }
}

// Jalankan tes koneksi saat file ini di-load
testConnection();

// Ekspor pool agar bisa digunakan di file lain (misalnya di controller)
module.exports = pool;