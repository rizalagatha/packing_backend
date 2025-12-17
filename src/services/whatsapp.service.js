const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

// --- KONFIGURASI PATH SESI ---
// Ini akan membuat folder .wwebjs_auth TEPAT di root folder project backend Anda
const SESSION_PATH = path.resolve(__dirname, "../../.wwebjs_auth");

// Pastikan folder cache ada (opsional, wwebjs biasanya buat sendiri)
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

// Objek untuk menampung semua instance client
const clients = {};
const SENDER_CLIENT_ID = "KDC"; // Default pengirim pusat

/**
 * Mendapatkan informasi status sesi
 */
const getSessionInfo = async (storeCode) => {
  const client = clients[storeCode];
  if (!client) return { status: "DISCONNECTED", info: null };

  try {
    const state = await client.getState();
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
    return { status: "INITIALIZING", info: null };
  }
};

/**
 * Membuat Client Baru
 */
const createClient = (storeCode) => {
  return new Promise((resolve, reject) => {
    console.log(`[WA] Menginisialisasi client untuk: ${storeCode}`);
    console.log(
      `[WA] Lokasi penyimpanan sesi: ${SESSION_PATH}/session-${storeCode}`
    );

    // Cek jika client sudah ada dan aktif
    if (clients[storeCode]) {
      console.log(`[WA] Client ${storeCode} sudah aktif.`);
      resolve("ALREADY_CONNECTED"); // Tidak perlu QR lagi
      return;
    }

    const client = new Client({
      restartOnAuthFail: true, // Auto restart jika auth gagal
      authStrategy: new LocalAuth({
        clientId: storeCode,
        dataPath: SESSION_PATH, // <--- KUNCI: Menentukan lokasi folder .wwebjs_auth
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
      },
    });

    // --- EVENT LISTENERS ---

    client.on("qr", (qr) => {
      console.log(`[WA] QR Code diterima untuk ${storeCode}`);
      resolve(qr); // Kirim QR ke frontend
    });

    client.on("ready", () => {
      console.log(`[WA] ✅ Client ${storeCode} SIAP!`);
      clients[storeCode] = client;
    });

    client.on("authenticated", () => {
      console.log(`[WA] ${storeCode} Terautentikasi.`);
    });

    client.on("auth_failure", (msg) => {
      console.error(`[WA] Autentikasi GAGAL ${storeCode}:`, msg);
      delete clients[storeCode]; // Hapus dari memori
    });

    client.on("disconnected", (reason) => {
      console.warn(`[WA] Client ${storeCode} TERPUTUS. Alasan: ${reason}`);
      delete clients[storeCode]; // Hapus agar bisa reconnect nanti
      // Opsional: Bisa panggil createClient(storeCode) lagi di sini untuk auto-reconnect
    });

    // Mulai inisialisasi
    try {
      client.initialize();
    } catch (err) {
      console.error("Gagal initialize client:", err);
      reject(err);
    }
  });
};

/**
 * Mengirim pesan DARI spesifik store
 */
const sendMessageFromClient = async (storeCode, number, message) => {
  const client = clients[storeCode];

  // Logic Re-hydrating (Opsional):
  // Jika client ada di folder tapi belum di-load ke memori (misal habis restart server),
  // Anda bisa memanggil createClient(storeCode) di sini secara diam-diam.

  if (!client) {
    return {
      success: false,
      error: `WA Store ${storeCode} belum terhubung/aktif.`,
    };
  }

  try {
    // Format nomor
    let formattedNumber = number.toString().replace(/\D/g, "");
    if (formattedNumber.startsWith("0"))
      formattedNumber = "62" + formattedNumber.slice(1);
    if (!formattedNumber.endsWith("@c.us")) formattedNumber += "@c.us";

    await client.sendMessage(formattedNumber, message);
    console.log(`[WA] Pesan terkirim dari ${storeCode} ke ${number}`);
    return { success: true };
  } catch (error) {
    console.error(`[WA Error] ${storeCode} -> ${number}:`, error);
    return { success: false, error: "Gagal mengirim pesan." };
  }
};

/**
 * Hapus Sesi
 */
const deleteSession = async (storeCode) => {
  const client = clients[storeCode];

  // 1. Logout & Destroy Client
  if (client) {
    try {
      await client.logout(); // Logout dari WA server
    } catch (e) {
      console.log("Logout error (abaikan):", e.message);
    }

    try {
      await client.destroy(); // Tutup browser
    } catch (e) {
      console.log("Destroy error (abaikan):", e.message);
    }

    delete clients[storeCode];
  }

  // 2. Hapus Folder Fisik
  const specificSessionPath = path.join(SESSION_PATH, `session-${storeCode}`);
  try {
    if (fs.existsSync(specificSessionPath)) {
      fs.rmSync(specificSessionPath, { recursive: true, force: true });
      console.log(`[WA] Folder sesi ${storeCode} dihapus.`);
    }
  } catch (error) {
    console.error(`[WA] Gagal hapus folder sesi: ${error.message}`);
  }

  return { success: true };
};

// ... (export fungsi lainnya: createClient, sendMessageFromClient, deleteSession, getSessionInfo)
// Export sendMessage dan sendMessageToStore (legacy) jika masih dipakai
const sendMessage = async () => {}; // Placeholder jika tidak dipakai lagi
const sendMessageToStore = async () => {}; // Placeholder

module.exports = {
  createClient,
  sendMessageFromClient,
  deleteSession,
  getSessionInfo,
  sendMessage,
  sendMessageToStore,
};
