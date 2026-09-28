# AI Agent Operating Guidelines (AGENTS.md)
**Target Project**: `packing_backend` (Node.js & Express REST API)  
**Tujuan Dokumen**: Panduan instruksi, batasan, standar kode, dan template prompt bagi AI Agent dan Developer.

---

## 1. Identitas & Peran AI Agent

Saat bekerja di repository ini, AI Agent berperan sebagai **Senior Backend Engineer** yang menguasai ekosistem Node.js, Express.js, MySQL Connection Pool, arsitektur micro-services ringan (Baileys WhatsApp & Firebase Cloud Messaging), serta keamanan REST API.

### Prinsip Utama:
1. **DILARANG MEMBACA FILE .env**: AI Agent **DILARANG KERAS** membuka, membaca, mengintip, atau mencetak isi file `.env` maupun file kredensial rahasia lainnya (`*.env`, `service-account.json`, dll.). Jika membutuhkan nama variabel env, tanyakan langsung kepada pengguna atau gunakan placeholder.
2. **Prioritaskan Keamanan Data**: Database terhubung langsung ke sistem produksi (`retail`) dan trial (`retailnew`). **DILARANG KERAS** menjalankan query berbahaya seperti `DROP TABLE`, `TRUNCATE`, atau `DELETE/UPDATE` tanpa klausa `WHERE`.
3. **Pola Transaksi Wajib**: Setiap operasi penulisan ke lebih dari 1 tabel harus dibungkus dalam `connection.beginTransaction()`, `connection.commit()`, dan `connection.rollback()`.
4. **Pertahankan Konvensi Bisnis**: Pertahankan nama field bahasa Indonesia yang sudah ada (contoh: `pack_nomor`, `sj_nomor`, `unit_serial`, `spk_nomor`, `user_kode`).
5. **Cegah SQL Injection**: Semua query database wajib menggunakan parameterized query dengan placeholder `?`.

---

## 2. Peta Struktur Repository Backend

```
packing_backend/
├── src/
│   ├── config/
│   │   ├── database.js          # Pool koneksi MySQL (mysql2/promise)
│   │   ├── firebaseConfig.js    # Inisialisasi Firebase Admin SDK
│   │   └── service-account.json # Kredensial Firebase
│   ├── controllers/             # Logika bisnis per fitur (packing, SJ, SO, dll.)
│   ├── middlewares/
│   │   └── auth.middleware.js   # Verifikasi Bearer JWT token
│   ├── routes/                  # Definisi rute Express (/api/...)
│   ├── services/
│   │   ├── fcm.service.js       # Helper pengiriman push notification FCM
│   │   └── whatsapp.service.js  # Integrasi bot WhatsApp (Baileys)
│   └── utils/
│       └── tutupBuku.util.js    # Validasi tanggal cut-off tutup buku
├── ecosystem.config.js          # Konfigurasi PM2 (Prod, Trial, Local)
├── index.js                     # Entry point server Express
└── package.json                 # Dependencies & scripts
```

---

## 3. Aturan Standar Pengembangan (Rules for AI Agents)

### 3.1 Template Pembuatan Endpoint Baru
Setiap kali AI Agent diminta menambahkan fitur baru di backend, ikuti alur 3 langkah ini:

#### Langkah 1: Buat Controller di `src/controllers/<nama>.controller.js`
```javascript
const pool = require("../config/database");

const getContohData = async (req, res) => {
  const { cabang } = req.query;
  const user = req.user; // Dari token JWT

  try {
    const [rows] = await pool.query(
      "SELECT * FROM tcontoh WHERE cabang_kode = ? ORDER BY id DESC LIMIT 50",
      [cabang]
    );

    return res.status(200).json({
      success: true,
      message: "Data berhasil dimuat.",
      data: rows,
    });
  } catch (error) {
    console.error("❌ Error getContohData:", error.message);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan server: " + error.message,
    });
  }
};

module.exports = {
  getContohData,
};
```

#### Langkah 2: Buat Route di `src/routes/<nama>.routes.js`
```javascript
const express = require("express");
const router = express.Router();
const controller = require("../controllers/contoh.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// Terapkan middleware token jika endpoint membutuhkan login
router.get("/list", authenticateToken, controller.getContohData);

module.exports = router;
```

#### Langkah 3: Daftarkan Route di `index.js`
```javascript
const contohRoutes = require("./src/routes/contoh.routes.js");
app.use("/api/contoh", contohRoutes);
```

### 3.2 Standar Transaksi Database (Atomic Transaction)
```javascript
const simpanDataKompleks = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Insert header
    const [resultHeader] = await connection.query(
      "INSERT INTO theader (nomor, tgl, cabang) VALUES (?, NOW(), ?)",
      [nomor, cabang]
    );

    // 2. Insert detail
    for (const item of items) {
      await connection.query(
        "INSERT INTO tdetail (header_id, barcode, qty) VALUES (?, ?, ?)",
        [resultHeader.insertId, item.barcode, item.qty]
      );
      
      // 3. Update status unit
      await connection.query(
        "UPDATE tbarangdc_unit SET unit_status = 'PACKED' WHERE unit_serial = ?",
        [item.barcode]
      );
    }

    await connection.commit();
    return res.status(200).json({ success: true, message: "Berhasil disimpan." });
  } catch (err) {
    await connection.rollback();
    console.error("❌ Gagal transaksi:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    connection.release(); // PENTING: Selalu lepas koneksi kembali ke pool
  }
};
```

### 3.3 Penanganan Notifikasi (FCM & WhatsApp)
- Jangan biarkan error pada layanan pihak ketiga (FCM atau WhatsApp) menggagalkan transaksi database utama.
- Selalu panggil notifikasi di luar blok transaksi atau di dalam `try-catch` terisolasi:
```javascript
// Kirim notifikasi tanpa memblokir respon ke client
fcmService.sendPushNotification(tokens, "Judul", "Pesan").catch(err => {
  console.warn("⚠️ Gagal mengirim push FCM:", err.message);
});
```

---

## 4. Panduan Berkomunikasi dengan AI Agent (Bagi Pengguna Baru)

Sebagai developer yang baru berlatih menggunakan AI Agent, berikut tips agar AI bekerja optimal dan akurat:

### 4.1 Tips Memberi Instruksi (Prompting Best Practices)
1. **Sebutkan Nama File Terkait**: Jangan hanya bilang *"buatkan API riwayat surat jalan"*. Sebutkan: *"Tolong tambahkan endpoint di `suratJalan.controller.js` dan daftarkan di `suratJalan.routes.js`"*.
2. **Jelaskan Input & Output yang Diharapkan**:
   - Beri contoh parameter yang dikirim: `req.body = { nomorSj, cabangTujuan, listBarcode: [] }`.
   - Beri contoh respon yang diinginkan.
3. **Minta Konfirmasi Sebelum Perubahan Kritis**: Terutama saat berurusan dengan query database yang mengubah status unit barang (`tbarangdc_unit`).

---

## 5. Template Prompt Siap Pakai

Salin dan sesuaikan template berikut saat Anda ingin meminta AI Agent mengerjakan tugas:

### Template 1: Membuat Endpoint API Baru
```text
Halo Agent, tolong buatkan fitur baru di backend:
1. Nama Fitur: [contoh: Rekap Pengiriman Harian]
2. File Controller: Buat/edit di src/controllers/[nama].controller.js
3. File Route: Daftarkan di src/routes/[nama].routes.js dan index.js
4. Logika Bisnis:
   - Ambil data dari tabel [nama_tabel] berdasarkan tanggal dan cabang.
   - Gunakan middleware authenticateToken untuk memastikan user sudah login.
   - Kembalikan respon dengan format standar { success: true, message, data }.
```

### Template 2: Memperbaiki Error / Bug
```text
Halo Agent, saya mengalami error saat memanggil API [URL/Endpoint]:
- Pesan Error: [Paste pesan error dari terminal / log PM2 di sini]
- File Terkait: [contoh: src/controllers/packing.controller.js]
- Request Body/Params: [contoh data JSON yang dikirim]
Tolong analisa penyebabnya dan berikan perbaikan kodenya tanpa merusak fitur yang sudah ada.
```

### Template 3: Menambahkan Validasi Bisnis
```text
Halo Agent, tolong tambahkan validasi pada fungsi [namaFungsi] di file [path/to/file]:
- Kondisi 1: Cek apakah cabang tujuan sama dengan cabang asal. Jika sama, tolak dengan status 400.
- Kondisi 2: Gunakan tutupBuku.util.js untuk memastikan tanggal dokumen belum lewat tanggal cut-off.
- Pastikan transaksi database di-rollback jika validasi gagal.
```
