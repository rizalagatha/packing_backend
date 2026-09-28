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
const pool = require("../config/database");

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

// --- SESI BERSAMA BAZAR ---
// Semua cabang berawalan "B" memakai satu sesi WA bersama bernama BAZAR.
// Tambahkan pengecualian di sini kalau ada cabang B yang perlu nomor sendiri.
const SHARED_BAZAR_KEY = "BAZAR";
const isBazarBranch = (code) =>
  String(code || "")
    .toUpperCase()
    .startsWith("B");
const getSessionName = (storeCode) =>
  isBazarBranch(storeCode) ? SHARED_BAZAR_KEY : storeCode;

// --- ANTREAN KIRIM ---
const connecting = {}; // uniqueId -> Promise (socket sedang dibuat)
const sendQueues = {}; // uniqueId -> ekor antrean
const pendingCount = {}; // uniqueId -> jumlah kiriman menunggu
const lastSentAt = {}; // uniqueId -> waktu kirim terakhir
const MIN_GAP_MS = 4000; // jeda minimum antar pesan pada 1 nomor
const GAP_JITTER_MS = 1500; // acak tambahan supaya tidak seperti robot
const MAX_QUEUE = 8; // lebih dari ini ditolak, jangan menumpuk

/**
 * HELPER: ID Unik untuk Prod vs Trial
 */
const getUniqueId = (storeCode) => {
  const base = getSessionName(storeCode);
  const appName = process.env.name || "";
  const appPort = process.env.PORT || "";
  if (appName.includes("trial") || appPort == "3002") {
    return `${base}_TRIAL`;
  }
  if (appName.includes("local") || appPort == "3004") {
    return `${base}_LOCAL`;
  }
  return `${base}_PROD`;
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

const startSocket = async (storeCode, uniqueId) => {
  const sessionPath = path.join(SESSION_DIR, uniqueId);
  console.log(`[BAILEYS] Memulai sesi untuk: ${uniqueId}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
    });

    clients[uniqueId] = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[BAILEYS] QR Baru diterima untuk ${uniqueId}`);
        qrStore[uniqueId] = qr;
        resolve(qr);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(
          `[BAILEYS] Koneksi ${uniqueId} terputus. Kode: ${statusCode}`,
        );

        // Hanya hapus kalau yang tertutup memang socket yang sedang aktif
        if (clients[uniqueId] === sock) {
          delete clients[uniqueId];
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[BAILEYS] ${uniqueId} logout. Sesi dihapus.`);
          delete qrStore[uniqueId];
          try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          } catch (e) {}
        } else if (statusCode === DisconnectReason.connectionReplaced) {
          // Ada instance lain memakai sesi yang sama. Jangan reconnect,
          // kalau tidak dua instance akan saling menendang tanpa henti.
          console.warn(`[BAILEYS] ${uniqueId} digantikan koneksi lain.`);
        } else {
          setTimeout(() => {
            createClient(storeCode).catch((err) =>
              console.error(
                `[BAILEYS] Reconnect ${uniqueId} gagal:`,
                err.message,
              ),
            );
          }, 3000);
        }
        // Tidak berpengaruh kalau promise sudah selesai karena QR / open
        reject(new Error("Koneksi WA terputus sebelum tersambung."));
      } else if (connection === "open") {
        console.log(`[BAILEYS] ${uniqueId} BERHASIL TERHUBUNG!`);
        delete qrStore[uniqueId];
        resolve(null);
      }
    });
  });
};

/**
 * Mengembalikan string QR kalau perlu scan, atau null kalau sudah terhubung.
 * Aman dipanggil berkali-kali: tidak akan membuat socket ganda.
 */
const createClient = (storeCode) => {
  const uniqueId = getUniqueId(storeCode);

  if (clients[uniqueId]?.user) {
    return Promise.resolve(null);
  }
  if (connecting[uniqueId]) {
    return connecting[uniqueId];
  }
  if (clients[uniqueId]) {
    // Socket sudah ada dan menunggu scan: kembalikan QR terbaru
    return Promise.resolve(qrStore[uniqueId] || null);
  }

  connecting[uniqueId] = startSocket(storeCode, uniqueId).finally(() => {
    delete connecting[uniqueId];
  });
  return connecting[uniqueId];
};

/**
 * Panggil sekali saat server start supaya sesi bersama hidup lagi
 * tanpa menunggu ada yang membuka layar QR.
 */
const restoreSharedSessions = async () => {
  if (process.env.NODE_ENV !== "production") {
    console.log("[BAILEYS] Restore sesi dilewati (bukan production).");
    return;
  }
  const uniqueId = getUniqueId(SHARED_BAZAR_KEY);
  const credsFile = path.join(SESSION_DIR, uniqueId, "creds.json");
  if (!fs.existsSync(credsFile)) {
    console.log(
      `[BAILEYS] ${uniqueId} belum pernah ditautkan, restore dilewati.`,
    );
    return;
  }
  try {
    const qr = await createClient(SHARED_BAZAR_KEY);
    console.log(
      qr
        ? `[BAILEYS] ${uniqueId} butuh scan ulang.`
        : `[BAILEYS] ${uniqueId} dipulihkan.`,
    );
  } catch (e) {
    console.error(`[BAILEYS] Restore ${uniqueId} gagal:`, e.message);
  }
};

const normalizeNumber = (number) => {
  let id = String(number || "").replace(/\D/g, "");
  if (id.startsWith("0")) id = "62" + id.slice(1);
  return id;
};

const enqueueSend = (uniqueId, job) => {
  const previous = sendQueues[uniqueId] || Promise.resolve();
  const run = previous.then(async () => {
    const gap = MIN_GAP_MS + Math.floor(Math.random() * GAP_JITTER_MS);
    const wait = gap - (Date.now() - (lastSentAt[uniqueId] || 0));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      return await job();
    } finally {
      lastSentAt[uniqueId] = Date.now();
    }
  });
  sendQueues[uniqueId] = run.catch(() => {});
  return run;
};

const logSend = async ({
  uniqueId,
  storeCode,
  meta,
  id,
  jenis,
  caption,
  result,
}) => {
  try {
    await pool.query(
      `INSERT INTO twa_send_log
        (session_key, cabang, user_kode, target, jenis, caption, status, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uniqueId,
        String(storeCode || "").slice(0, 10),
        String(meta.user || "").slice(0, 20),
        id.slice(0, 20),
        jenis,
        String(caption || "").slice(0, 255),
        result.success ? "OK" : "GAGAL",
        String(result.error || "").slice(0, 255),
      ],
    );
  } catch (e) {
    console.error("[BAILEYS] Gagal menulis log kirim:", e.message);
  }
};

const deliver = async ({
  storeCode,
  number,
  jenis,
  caption,
  meta,
  buildContent,
}) => {
  const uniqueId = getUniqueId(storeCode);
  const id = normalizeNumber(number);
  const jid = id + "@s.whatsapp.net";

  if ((pendingCount[uniqueId] || 0) >= MAX_QUEUE) {
    return {
      success: false,
      error: "Antrean pengiriman penuh, coba lagi sebentar.",
    };
  }
  pendingCount[uniqueId] = (pendingCount[uniqueId] || 0) + 1;

  const result = await enqueueSend(uniqueId, async () => {
    const sock = clients[uniqueId];
    if (!sock?.user) {
      return {
        success: false,
        error: "WA belum terhubung. Hubungi admin untuk menautkan ulang.",
      };
    }
    try {
      console.log(`[BAILEYS] Mengirim ${jenis} dari ${uniqueId} ke ${jid}`);
      const [check] = await sock.onWhatsApp(jid);
      if (!check?.exists) {
        return {
          success: false,
          error: "Nomor tersebut tidak terdaftar di WhatsApp.",
        };
      }
      await sock.sendMessage(jid, buildContent());
      return { success: true };
    } catch (error) {
      console.error("[BAILEYS SEND ERROR]", error);
      return { success: false, error: "Gagal kirim. Coba lagi." };
    }
  }).finally(() => {
    pendingCount[uniqueId] -= 1;
  });

  await logSend({ uniqueId, storeCode, meta, id, jenis, caption, result });
  return result;
};

const sendMessageFromClient = (storeCode, number, message, meta = {}) =>
  deliver({
    storeCode,
    number,
    jenis: "TEXT",
    caption: message,
    meta,
    buildContent: () => ({ text: message }),
  });

const sendImageFromClient = (
  storeCode,
  number,
  fileBuffer,
  caption = "",
  meta = {},
) =>
  deliver({
    storeCode,
    number,
    jenis: "IMAGE",
    caption,
    meta,
    buildContent: () => ({ image: fileBuffer, caption }),
  });

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

  delete qrStore[uniqueId];
  delete connecting[uniqueId];

  return { success: true };
};

module.exports = {
  createClient,
  sendMessageFromClient,
  sendImageFromClient,
  deleteSession,
  getSessionInfo,
  getUniqueId,
  isSharedBranch: isBazarBranch,
  restoreSharedSessions,
};
