const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");

// --- CARA PAMUNGKAS: SIMPAN SESI DI LUAR PROJECT ---
// Folder ini tidak akan dipantau oleh PM2, jadi AMAN dari restart loop.
const SESSION_DIR = "/var/www/wa_sessions";

// Pastikan folder induk ada (Fallback check)
if (!fs.existsSync(SESSION_DIR)) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  } catch (err) {
    console.error("[WA INIT] Gagal akses folder eksternal:", err);
  }
}

const clients = {};

/**
 * HELPER: Membedakan ID Sesi antara Prod dan Trial
 */
const getUniqueId = (storeCode) => {
  // Cek environment variable dari PM2
  // Pastikan di ecosystem.config.js masing-masing app punya nama beda atau port beda
  const appName = process.env.name || "";
  const appPort = process.env.PORT || "";

  if (appName.includes("trial") || appPort == "3002") {
    return `${storeCode}_TRIAL`;
  } else {
    return `${storeCode}_PROD`;
  }
};

const getSessionInfo = async (storeCode) => {
  const uniqueId = getUniqueId(storeCode);
  const client = clients[uniqueId];

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
    return { status: "DISCONNECTED", info: null };
  }
};

const createClient = (storeCode) => {
  const uniqueId = getUniqueId(storeCode);

  return new Promise((resolve, reject) => {
    console.log(`[WA START] Memulai client untuk ID: ${uniqueId}`);
    console.log(`[WA PATH] Lokasi sesi: ${SESSION_DIR}/session-${uniqueId}`);

    if (clients[uniqueId]) {
      try {
        clients[uniqueId].destroy();
      } catch (e) {}
      delete clients[uniqueId];
    }

    const client = new Client({
      restartOnAuthFail: true,
      authStrategy: new LocalAuth({
        clientId: uniqueId,
        dataPath: SESSION_DIR, // <--- MENYIMPAN DI LUAR PROJECT
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
      console.error(`[WA FAIL] Gagal Auth ${uniqueId}:`, msg);
    });

    client.on("disconnected", async (reason) => {
      console.warn(
        `[WA DISCONNECT] Client ${uniqueId} PUTUS. Alasan: ${reason}`
      );
      try {
        await client.destroy();
      } catch (e) {}
      delete clients[uniqueId];
    });

    console.log("[WA INIT] Menginisialisasi Puppeteer...");
    client.initialize().catch((err) => {
      console.error("[WA INIT ERROR]", err);
      reject(new Error("Gagal inisialisasi WA Web."));
    });
  });
};

const sendMessageFromClient = async (storeCode, number, message) => {
  const uniqueId = getUniqueId(storeCode);
  console.log(`[WA SEND] Request dari ${uniqueId} ke ${number}`);

  const client = clients[uniqueId];
  if (!client) return { success: false, error: "WA belum terhubung." };

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

const deleteSession = async (storeCode) => {
  const uniqueId = getUniqueId(storeCode);
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

  // Hapus folder di lokasi eksternal
  const specificSessionPath = path.join(SESSION_DIR, `session-${uniqueId}`);
  setTimeout(() => {
    try {
      if (fs.existsSync(specificSessionPath)) {
        fs.rmSync(specificSessionPath, { recursive: true, force: true });
        console.log(`[WA DELETE] Folder dihapus: ${specificSessionPath}`);
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
