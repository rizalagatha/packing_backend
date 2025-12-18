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

  // Cek koneksi socket
  if (!sock) {
    console.log(`[BAILEYS] Socket ${uniqueId} tidak aktif.`);
    return {
      success: false,
      error: "WA Store belum terhubung. Silakan scan ulang.",
    };
  }

  try {
    // 1. Format JID (Jabber ID) WhatsApp
    // number yang masuk dari controller sudah bersih (628...), tapi kita pastikan lagi
    let id = number.toString().replace(/\D/g, "");
    if (id.startsWith("0")) id = "62" + id.slice(1);

    // Tambahkan suffix domain WA
    const jid = id + "@s.whatsapp.net";

    console.log(`[BAILEYS] Mengirim pesan dari ${uniqueId} ke ${jid}`);

    // 2. [OPSIONAL] Cek apakah nomor terdaftar di WA
    // Fitur ini memastikan nomor valid sebelum kirim
    const [result] = await sock.onWhatsApp(jid);
    if (result?.exists) {
      // 3. Kirim Pesan
      await sock.sendMessage(jid, { text: message });
      return { success: true };
    } else {
      console.warn(`[BAILEYS] Nomor ${id} tidak terdaftar di WA.`);
      return {
        success: false,
        error: "Nomor tersebut tidak terdaftar di WhatsApp.",
      };
    }
  } catch (error) {
    console.error(`[BAILEYS ERROR]`, error);
    // Tangani jika socket putus tiba-tiba
    return { success: false, error: "Gagal kirim. Coba scan ulang QR." };
  }
};

/**
 * Kirim Gambar (Image)
 * fileBuffer: Data gambar dalam bentuk Buffer (dari Multer)
 * caption: Teks keterangan (opsional)
 */
const sendImageFromClient = async (
  storeCode,
  number,
  fileBuffer,
  caption = ""
) => {
  const uniqueId = getUniqueId(storeCode);
  let sock = clients[uniqueId];

  if (!sock) return { success: false, error: "WA belum terhubung." };

  try {
    let id = number.toString().replace(/\D/g, "");
    if (id.startsWith("0")) id = "62" + id.slice(1);
    const jid = id + "@s.whatsapp.net";

    console.log(`[BAILEYS] Mengirim GAMBAR ke ${jid}`);

    // Cek nomor dulu
    const [result] = await sock.onWhatsApp(jid);
    if (!result?.exists) {
      return { success: false, error: "Nomor tidak terdaftar di WA." };
    }

    // KIRIM GAMBAR
    await sock.sendMessage(jid, {
      image: fileBuffer,
      caption: caption,
    });

    return { success: true };
  } catch (error) {
    console.error(`[BAILEYS IMG ERROR]`, error);
    return { success: false, error: "Gagal kirim gambar." };
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
  sendImageFromClient,
  deleteSession,
  getSessionInfo,
};
