const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// --- KONFIGURASI SESI ---
// Simpan di luar folder project agar aman dari PM2
const SESSION_DIR = "/var/www/wa_sessions_baileys";

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Simpan instance socket di memori
const clients = {};
// Simpan QR code sementara (jika client belum scan)
const qrStore = {};

/**
 * HELPER: ID Unik untuk Prod vs Trial
 */
const getUniqueId = (storeCode) => {
  const appName = process.env.name || "";
  const appPort = process.env.PORT || "";
  if (appName.includes("trial") || appPort == "3002") {
    return `${storeCode}_TRIAL`;
  } else {
    return `${storeCode}_PROD`;
  }
};

/**
 * Mendapatkan Status Sesi
 */
const getSessionInfo = async (storeCode) => {
  const uniqueId = getUniqueId(storeCode);
  const sock = clients[uniqueId];

  if (!sock) return { status: "DISCONNECTED", info: null };

  // Cek apakah user object ada (tandanya sudah login)
  if (sock.user) {
    return {
      status: "CONNECTED",
      info: {
        pushname: sock.user.name || "WhatsApp User",
        wid: { user: sock.user.id.split(":")[0] }, // Ambil nomornya saja
        platform: "Baileys",
      },
    };
  }

  return { status: "DISCONNECTED", info: null };
};

/**
 * Inisialisasi Koneksi (Create Client)
 * Mengembalikan Promise berisi string QR Code
 */
const createClient = async (storeCode) => {
  const uniqueId = getUniqueId(storeCode);
  const sessionPath = path.join(SESSION_DIR, uniqueId);

  return new Promise(async (resolve, reject) => {
    console.log(`[BAILEYS] Memulai sesi untuk: ${uniqueId}`);

    // Jika sudah ada instance aktif dan terhubung
    if (clients[uniqueId]?.user) {
      console.log(`[BAILEYS] ${uniqueId} sudah terhubung.`);
      // Jika sudah connect, return null (frontend akan anggap connected)
      // Atau return string khusus
      resolve(null);
      return;
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true, // Tampilkan di log server juga
      logger: pino({ level: "silent" }), // Supaya log bersih
      browser: Browsers.macOS("Desktop"), // Agar terlihat seperti WA Web biasa
      syncFullHistory: false, // Hemat RAM, gak usah load chat lama
    });

    clients[uniqueId] = sock;

    // --- EVENT LISTENER ---

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[BAILEYS] QR Baru diterima untuk ${uniqueId}`);
        qrStore[uniqueId] = qr;
        resolve(qr); // Kirim QR ke Controller -> Frontend
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect.error?.output?.statusCode !==
          DisconnectReason.loggedOut;
        console.log(
          `[BAILEYS] Koneksi ${uniqueId} terputus. Reconnect: ${shouldReconnect}`
        );

        // Hapus session dari memory
        delete clients[uniqueId];

        if (shouldReconnect) {
          createClient(storeCode); // Auto Reconnect
        } else {
          console.log(`[BAILEYS] ${uniqueId} Logout. Sesi dihapus.`);
          // Logout manual, hapus folder
          try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          } catch (e) {}
        }
      } else if (connection === "open") {
        console.log(`[BAILEYS] ${uniqueId} BERHASIL TERHUBUNG!`);
        delete qrStore[uniqueId];
        // Resolve dengan null karena tidak butuh QR lagi
        resolve(null);
      }
    });
  });
};

/**
 * Kirim Pesan
 */
const sendMessageFromClient = async (storeCode, number, message) => {
  const uniqueId = getUniqueId(storeCode);
  let sock = clients[uniqueId];

  // Jika socket tidak ada di memori (misal habis restart server),
  // Coba inisialisasi ulang diam-diam jika file sesi ada
  if (!sock) {
    console.log(`[BAILEYS] Socket ${uniqueId} tidak aktif, mencoba restore...`);
    const sessionPath = path.join(SESSION_DIR, uniqueId);
    if (fs.existsSync(sessionPath)) {
      // Restore session (tanpa await QR)
      createClient(storeCode);
      // Tunggu sebentar biar connect
      await new Promise((r) => setTimeout(r, 3000));
      sock = clients[uniqueId];
    }
  }

  if (!sock) {
    return { success: false, error: "WA Store belum terhubung." };
  }

  try {
    // Format Nomor (08xx -> 628xx@s.whatsapp.net)
    let id = number.toString().replace(/\D/g, "");
    if (id.startsWith("0")) id = "62" + id.slice(1);

    // JID Baileys format: nomor@s.whatsapp.net
    if (!id.endsWith("@s.whatsapp.net")) id = id + "@s.whatsapp.net";

    console.log(`[BAILEYS] Mengirim ke ${id}`);

    await sock.sendMessage(id, { text: message });

    return { success: true };
  } catch (error) {
    console.error(`[BAILEYS ERROR]`, error);
    return { success: false, error: "Gagal kirim pesan." };
  }
};

/**
 * Hapus Sesi
 */
const deleteSession = async (storeCode) => {
  const uniqueId = getUniqueId(storeCode);
  const sock = clients[uniqueId];
  const sessionPath = path.join(SESSION_DIR, uniqueId);

  console.log(`[BAILEYS] Menghapus sesi ${uniqueId}`);

  if (sock) {
    try {
      await sock.logout();
    } catch (e) {}
    try {
      sock.end();
    } catch (e) {}
    delete clients[uniqueId];
  }

  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("Gagal hapus folder:", e);
  }

  return { success: true };
};

module.exports = {
  createClient,
  sendMessageFromClient,
  deleteSession,
  getSessionInfo,
};
