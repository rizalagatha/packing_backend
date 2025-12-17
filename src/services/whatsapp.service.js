const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs");
const path = require("path");

// --- SIMPAN SESI DI LUAR PROJECT (Cara kemarin) ---
const SESSION_DIR = "/var/www/wa_sessions";

if (!fs.existsSync(SESSION_DIR)) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  } catch (err) {
    console.error("[WA INIT] Gagal akses folder eksternal:", err);
  }
}

const clients = {};

const getUniqueId = (storeCode) => {
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
        dataPath: SESSION_DIR,
      }),
      // --- TAMBAHAN PENTING: OPTIMASI PUPPETEER ---
      puppeteer: {
        headless: true, // atau 'new' jika pakai versi terbaru
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", // Mengatasi masalah memori di Linux
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--disable-extensions", // Matikan ekstensi
          "--disable-software-rasterizer",
        ],
        // Timeout lebih lama agar tidak error saat loading chat banyak
        timeout: 60000,
      },
      // Cache versi WA Web agar tidak download ulang terus (Hemat resource)
      webVersionCache: {
        type: "remote",
        remotePath:
          "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
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

  const specificSessionPath = path.join(SESSION_DIR, `session-${uniqueId}`);
  setTimeout(() => {
    try {
      if (fs.existsSync(specificSessionPath)) {
        fs.rmSync(specificSessionPath, { recursive: true, force: true });
      }
    } catch (error) {}
  }, 1000);

  return { success: true };
};

module.exports = {
  createClient,
  sendMessageFromClient,
  deleteSession,
  getSessionInfo,
};
