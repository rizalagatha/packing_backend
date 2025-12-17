const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");

// --- KONFIGURASI PATH SESI (FIXED) ---
// Gunakan process.cwd() agar folder dibuat di root project (sejajar dengan package.json)
const SESSION_DIR = path.join(process.cwd(), ".wwebjs_auth");

// Pastikan folder induk ada
if (!fs.existsSync(SESSION_DIR)) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    console.log(`[WA INIT] Folder sesi dibuat di: ${SESSION_DIR}`);
  } catch (err) {
    console.error("[WA INIT] Gagal membuat folder sesi:", err);
  }
}

const clients = {}; // Menyimpan instance client yang aktif

/**
 * Mendapatkan informasi status sesi
 */
const getSessionInfo = async (storeCode) => {
  const client = clients[storeCode];

  if (!client) {
    return { status: "DISCONNECTED", info: null };
  }

  try {
    const state = await client.getState();
    console.log(`[WA CHECK] ${storeCode} State: ${state}`);

    if (state === "CONNECTED") {
      const info = client.info;
      return {
        status: "CONNECTED",
        info: {
          pushname: info.pushname,
          wid: info.wid,
          platform: info.platform,
        },
      };
    }
    return { status: state || "DISCONNECTED", info: null };
  } catch (error) {
    console.error(`[WA CHECK ERROR] ${storeCode}:`, error.message);
    // Jika client object ada tapi error saat getState, mungkin sedang restart/zombie
    return { status: "DISCONNECTED", info: null };
  }
};

/**
 * Membuat Client Baru (Generate QR)
 */
const createClient = (storeCode) => {
  return new Promise((resolve, reject) => {
    console.log(`[WA START] Memulai client untuk: ${storeCode}`);

    // Jika sudah ada instance di memori, hancurkan dulu biar bersih
    if (clients[storeCode]) {
      console.log(`[WA START] Menutup sesi lama ${storeCode}...`);
      try {
        clients[storeCode].destroy();
      } catch (e) {}
      delete clients[storeCode];
    }

    const client = new Client({
      restartOnAuthFail: true,
      authStrategy: new LocalAuth({
        clientId: storeCode,
        dataPath: SESSION_DIR, // Folder: .wwebjs_auth/session-<storeCode>
      }),
      puppeteer: {
        headless: true,
        // Argumen ini PENTING agar tidak crash di server/VPS/Docker
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
        ],
      },
    });

    // --- EVENT LISTENERS ---

    client.on("qr", (qr) => {
      console.log(`[WA QR] QR Code siap untuk ${storeCode}`);
      resolve(qr); // Kirim QR ke frontend
    });

    client.on("ready", () => {
      console.log(`[WA READY] Client ${storeCode} SIAP digunakan!`);
      clients[storeCode] = client;
    });

    client.on("authenticated", () => {
      console.log(`[WA AUTH] ${storeCode} Berhasil Login! Menyimpan sesi...`);
    });

    client.on("auth_failure", (msg) => {
      console.error(`[WA FAIL] Autentikasi GAGAL ${storeCode}:`, msg);
      // Hapus sesi rusak
      deleteSession(storeCode);
    });

    client.on("disconnected", (reason) => {
      console.warn(
        `[WA DISCONNECT] Client ${storeCode} TERPUTUS. Alasan: ${reason}`
      );
      delete clients[storeCode];
      // Opsi: Anda bisa mencoba createClient(storeCode) lagi di sini untuk auto-reconnect
    });

    // Mulai inisialisasi
    console.log("[WA INIT] Menginisialisasi Puppeteer...");
    client.initialize().catch((err) => {
      console.error("[WA INIT ERROR]", err);
      reject(new Error("Gagal inisialisasi WA Web."));
    });
  });
};

/**
 * Mengirim pesan DARI spesifik store
 */
const sendMessageFromClient = async (storeCode, number, message) => {
  console.log(`[WA SEND] Request kirim dari ${storeCode} ke ${number}`);

  const client = clients[storeCode];

  // Cek apakah client ada di memori
  if (!client) {
    console.error(
      `[WA SEND FAIL] Client ${storeCode} tidak ditemukan di memori.`
    );
    return {
      success: false,
      error: "WA Store belum terhubung (Sesi mati/restart).",
    };
  }

  try {
    // Cek Status Koneksi dulu
    const state = await client.getState();
    if (state !== "CONNECTED") {
      console.warn(`[WA SEND WARN] Status client ${storeCode} adalah ${state}`);
      // Jangan return false dulu, kadang wwebjs bisa tetap kirim meski status aneh
    }

    // Format nomor HP (Sangat Penting!)
    // Pastikan hanya angka
    let formattedNumber = number.toString().replace(/\D/g, "");

    // Handle 08... -> 628...
    if (formattedNumber.startsWith("0")) {
      formattedNumber = "62" + formattedNumber.slice(1);
    }
    // Handle user kirim '628...' tapi tanpa @c.us
    if (!formattedNumber.endsWith("@c.us")) {
      formattedNumber += "@c.us";
    }

    console.log(`[WA SEND] Mengirim ke ID: ${formattedNumber}`);

    await client.sendMessage(formattedNumber, message);
    console.log(`[WA SEND SUCCESS] Pesan terkirim.`);
    return { success: true };
  } catch (error) {
    console.error(`[WA SEND ERROR]`, error);
    return { success: false, error: "Gagal kirim pesan: " + error.message };
  }
};

/**
 * Hapus Sesi
 */
const deleteSession = async (storeCode) => {
  console.log(`[WA DELETE] Menghapus sesi ${storeCode}`);
  const client = clients[storeCode];

  if (client) {
    try {
      await client.logout();
    } catch (e) {}
    try {
      await client.destroy();
    } catch (e) {}
    delete clients[storeCode];
  }

  // Hapus folder fisik .wwebjs_auth/session-<storeCode>
  const specificSessionPath = path.join(SESSION_DIR, `session-${storeCode}`);

  // Gunakan fs delay sedikit untuk memastikan file lock lepas
  setTimeout(() => {
    try {
      if (fs.existsSync(specificSessionPath)) {
        fs.rmSync(specificSessionPath, { recursive: true, force: true });
        console.log(`[WA DELETE] Folder ${specificSessionPath} dihapus.`);
      }
    } catch (error) {
      console.error(`[WA DELETE ERROR] Gagal hapus folder: ${error.message}`);
    }
  }, 1000);

  return { success: true };
};

module.exports = {
  createClient,
  sendMessageFromClient,
  deleteSession,
  getSessionInfo,
};
