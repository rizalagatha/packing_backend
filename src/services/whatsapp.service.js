const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");

// --- KONFIGURASI PATH SESI ---
const SESSION_DIR = path.join(process.cwd(), ".wwebjs_auth");

if (!fs.existsSync(SESSION_DIR)) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  } catch (err) {
    console.error("[WA INIT] Gagal membuat folder sesi:", err);
  }
}

const clients = {};

/**
 * HELPER: Membedakan ID Sesi antara Prod dan Trial
 * Agar folder sesinya tidak bentrok.
 */
const getUniqueId = (storeCode) => {
  // Cek apakah aplikasi ini berjalan di port Trial (3002) atau namanya mengandung 'trial'
  const isTrial =
    process.env.PORT == 3002 ||
    (process.env.name && process.env.name.includes("trial"));

  if (isTrial) {
    return `${storeCode}_TRIAL`; // Hasil: K06_TRIAL
  } else {
    return `${storeCode}_PROD`; // Hasil: K06_PROD
  }
};

/**
 * Mendapatkan informasi status sesi
 */
const getSessionInfo = async (storeCode) => {
  const uniqueId = getUniqueId(storeCode); // Gunakan ID Unik
  const client = clients[uniqueId];

  if (!client) {
    return { status: "DISCONNECTED", info: null };
  }

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
    return { status: "DISCONNECTED", info: null };
  }
};

/**
 * Membuat Client Baru
 */
const createClient = (storeCode) => {
  const uniqueId = getUniqueId(storeCode); // Gunakan ID Unik

  return new Promise((resolve, reject) => {
    console.log(`[WA START] Memulai client untuk ID Unik: ${uniqueId}`);

    if (clients[uniqueId]) {
      console.log(`[WA START] Menutup sesi lama ${uniqueId}...`);
      try {
        clients[uniqueId].destroy();
      } catch (e) {}
      delete clients[uniqueId];
    }

    const client = new Client({
      restartOnAuthFail: true,
      authStrategy: new LocalAuth({
        clientId: uniqueId, // <--- INI KUNCINYA (Folder sesi akan beda nama)
        dataPath: SESSION_DIR,
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
          "--single-process",
          "--disable-gpu",
        ],
      },
    });

    client.on("qr", (qr) => {
      console.log(`[WA QR] QR Code siap untuk ${uniqueId}`);
      resolve(qr);
    });

    client.on("ready", () => {
      console.log(`[WA READY] Client ${uniqueId} SIAP digunakan!`);
      clients[uniqueId] = client;
    });

    client.on("authenticated", () => {
      console.log(`[WA AUTH] ${uniqueId} Berhasil Login!`);
    });

    client.on("auth_failure", (msg) => {
      console.error(`[WA FAIL] Autentikasi GAGAL ${uniqueId}:`, msg);
      deleteSession(storeCode); // Panggil deleteSession (pakai storeCode asli, nanti di-convert di dalam)
    });

    client.on("disconnected", async (reason) => {
      console.warn(
        `[WA DISCONNECT] Client ${uniqueId} TERPUTUS. Alasan: ${reason}`
      );
      try {
        await client.destroy();
      } catch (e) {}
      delete clients[uniqueId];

      if (reason === "LOGOUT" || reason === "CONFLICT") {
        // Hapus folder sesi spesifik
        const specificPath = path.join(SESSION_DIR, `session-${uniqueId}`);
        try {
          if (fs.existsSync(specificPath))
            fs.rmSync(specificPath, { recursive: true, force: true });
        } catch (e) {}
      }
    });

    console.log("[WA INIT] Menginisialisasi Puppeteer...");
    client.initialize().catch((err) => {
      console.error("[WA INIT ERROR]", err);
      reject(new Error("Gagal inisialisasi WA Web."));
    });
  });
};

/**
 * Mengirim pesan
 */
const sendMessageFromClient = async (storeCode, number, message) => {
  const uniqueId = getUniqueId(storeCode); // Gunakan ID Unik
  console.log(`[WA SEND] Request dari ${uniqueId} ke ${number}`);

  const client = clients[uniqueId];

  if (!client) {
    return {
      success: false,
      error: `WA Store ${storeCode} (${uniqueId}) belum terhubung.`,
    };
  }

  try {
    let formattedNumber = number.toString().replace(/\D/g, "");
    if (formattedNumber.startsWith("0"))
      formattedNumber = "62" + formattedNumber.slice(1);
    if (!formattedNumber.endsWith("@c.us")) formattedNumber += "@c.us";

    await client.sendMessage(formattedNumber, message);
    return { success: true };
  } catch (error) {
    console.error(`[WA SEND ERROR]`, error);
    return { success: false, error: "Gagal kirim pesan." };
  }
};

/**
 * Hapus Sesi
 */
const deleteSession = async (storeCode) => {
  const uniqueId = getUniqueId(storeCode); // Gunakan ID Unik
  console.log(`[WA DELETE] Menghapus sesi ${uniqueId}`);

  const client = clients[uniqueId];
  if (client) {
    try {
      await client.logout();
    } catch (e) {}
    try {
      await client.destroy();
    } catch (e) {}
    delete clients[uniqueId];
  }

  // Hapus folder fisik session-K06_PROD atau session-K06_TRIAL
  const specificSessionPath = path.join(SESSION_DIR, `session-${uniqueId}`);

  setTimeout(() => {
    try {
      if (fs.existsSync(specificSessionPath)) {
        fs.rmSync(specificSessionPath, { recursive: true, force: true });
        console.log(`[WA DELETE] Folder ${specificSessionPath} dihapus.`);
      }
    } catch (error) {
      console.error(`[WA DELETE ERROR]`, error.message);
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
