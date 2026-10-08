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

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GREETINGS = [
  "Kak, ini struknya ya. Makasih udah mampir di Kaosan 🙏",
  "Struk belanjanya kak, makasih ya",
  "Halo kak, ini struk tadi. Semoga suka sama belanjaannya",
  "Ini struknya kak. Ditunggu belanja lagi ya",
  "Makasih ya kak udah belanja tadi. Struknya di sini",
  "Hai kak, struknya kami kirim di sini ya",
  "Struk belanja kakak ya. Makasih banyak 😊",
  "Kak, ini bukti belanjanya ya. Makasih udah mampir",
  "Makasih kak! Ini struknya, simpan ya kalau nanti perlu tukar",
  "Halo kak, struknya ya. Kalau ada yang kurang pas, kabari aja",
  "Ini struk belanjanya kak, makasih udah mampir ke stand kami",
  "Struknya kak. Sehat selalu dan makasih ya",
];

function varyCaption(caption) {
  const greet = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  return `${greet}\n\n${caption || ""}`.trim();
}

// --- ANTI-DETEKSI: batas harian, jeda acak, istirahat ---
const DAILY_LIMIT = 100; // naikkan bertahap kalau nomor sudah "matang"
const REST_EVERY = 10; // istirahat panjang tiap N pesan
const REST_MIN_MS = 60000;
const REST_MAX_MS = 120000;
const GAP_MIN_MS = 6000;
const GAP_MAX_MS = 15000;

const sendStats = {}; // uniqueId -> { date, count }
const sinceRest = {}; // uniqueId -> jumlah kiriman sejak istirahat terakhir

// Tanggal WIB (UTC+7) supaya hitungan harian ganti hari tepat tengah malam
const todayWib = () =>
  new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

const getDailyCount = (uniqueId) => {
  const today = todayWib();
  if (!sendStats[uniqueId] || sendStats[uniqueId].date !== today) {
    sendStats[uniqueId] = { date: today, count: 0 };
  }
  return sendStats[uniqueId].count;
};

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
// Semua cabang berawalan "B" memakai pool nomor WA bersama (2 slot).
const SHARED_SLOTS = ["BAZAR", "BAZAR2"];
const SHARED_BAZAR_KEY = SHARED_SLOTS[0];
const isBazarBranch = (code) =>
  String(code || "")
    .toUpperCase()
    .startsWith("B");
const normalizeSlot = (slot) =>
  SHARED_SLOTS.includes(slot) ? slot : SHARED_SLOTS[0];
const getSessionName = (storeCode, slot) =>
  isBazarBranch(storeCode) ? normalizeSlot(slot) : storeCode;

// --- ANTREAN KIRIM ---
const connecting = {}; // uniqueId -> Promise (socket sedang dibuat)
const sendQueues = {}; // uniqueId -> ekor antrean
const pendingCount = {}; // uniqueId -> jumlah kiriman menunggu
const lastSentAt = {}; // uniqueId -> waktu kirim terakhir
const connectedSince = {}; // uniqueId -> waktu socket terhubung
const MAX_QUEUE = 8; // lebih dari ini ditolak, jangan menumpuk

/**
 * HELPER: ID Unik untuk Prod vs Trial
 */
const getUniqueId = (storeCode, slot) => {
  const base = getSessionName(storeCode, slot);
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
const getSessionInfo = async (storeCode, slot) => {
  const uniqueId = getUniqueId(storeCode, slot);
  const sock = clients[uniqueId];
  const shared = isBazarBranch(storeCode);

  if (sock?.user) {
    return {
      status: "CONNECTED",
      shared,
      info: {
        pushname: sock.user.name || "WhatsApp User",
        wid: { user: sock.user.id.split(":")[0] },
        platform: "Baileys",
        connectedAt: connectedSince[uniqueId]
          ? new Date(connectedSince[uniqueId]).toISOString()
          : null,
        queue: pendingCount[uniqueId] || 0,
      },
    };
  }

  return { status: "DISCONNECTED", shared, info: null };
};

const QR_WAIT_MS = 25000;

const startSocket = async (storeCode, uniqueId, slot) => {
  const sessionPath = path.join(SESSION_DIR, uniqueId);
  console.log(`[BAILEYS] Memulai sesi untuk: ${uniqueId}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Ambil versi WA Web terbaru, tapi jangan menunggu tanpa batas kalau
  // server tidak bisa mengakses internet. Tanpa versi, Baileys pakai bawaan.
  let version;
  try {
    const latest = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((resolve) => setTimeout(() => resolve({}), 8000)),
    ]);
    version = latest.version;
  } catch (e) {}
  console.log(
    `[BAILEYS] ${uniqueId} versi WA Web: ${version ? version.join(".") : "bawaan"}`,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    let waitTimer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      fn(value);
    };

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
    });

    clients[uniqueId] = sock;

    // Kalau QR tidak muncul dalam batas waktu, batalkan supaya request
    // tidak menggantung dan percobaan berikutnya mulai dari nol.
    waitTimer = setTimeout(() => {
      if (settled) return;
      abandoned = true;
      console.warn(
        `[BAILEYS] ${uniqueId} tidak menghasilkan QR dalam ${QR_WAIT_MS / 1000} detik.`,
      );
      try {
        sock.end(undefined);
      } catch (e) {}
      if (clients[uniqueId] === sock) {
        delete clients[uniqueId];
      }
      finish(reject, new Error("QR_TIMEOUT"));
    }, QR_WAIT_MS);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[BAILEYS] QR Baru diterima untuk ${uniqueId}`);
        qrStore[uniqueId] = qr;
        finish(resolve, qr);
      }

      if (connection === "close") {
        if (abandoned) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(
          `[BAILEYS] Koneksi ${uniqueId} terputus. Kode: ${statusCode}`,
        );

        if (clients[uniqueId] === sock) {
          delete clients[uniqueId];
          delete connectedSince[uniqueId];
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[BAILEYS] ${uniqueId} logout. Sesi dihapus.`);
          delete qrStore[uniqueId];
          try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          } catch (e) {}
        } else if (statusCode === DisconnectReason.connectionReplaced) {
          console.warn(`[BAILEYS] ${uniqueId} digantikan koneksi lain.`);
        } else {
          setTimeout(() => {
            createClient(storeCode, slot).catch((err) =>
              console.error(
                `[BAILEYS] Reconnect ${uniqueId} gagal:`,
                err.message,
              ),
            );
          }, 3000);
        }
        finish(reject, new Error("Koneksi WA terputus sebelum tersambung."));
      } else if (connection === "open") {
        console.log(`[BAILEYS] ${uniqueId} BERHASIL TERHUBUNG!`);
        connectedSince[uniqueId] = Date.now();
        delete qrStore[uniqueId];
        finish(resolve, null);
      }
    });
  });
};

/**
 * Mengembalikan string QR kalau perlu scan, atau null kalau sudah terhubung.
 * Aman dipanggil berkali-kali: tidak akan membuat socket ganda.
 */
const createClient = (storeCode, slot) => {
  const uniqueId = getUniqueId(storeCode, slot);

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

  connecting[uniqueId] = startSocket(storeCode, uniqueId, slot).finally(() => {
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
  for (const slot of SHARED_SLOTS) {
    const uniqueId = getUniqueId(SHARED_BAZAR_KEY, slot);
    const credsFile = path.join(SESSION_DIR, uniqueId, "creds.json");
    if (!fs.existsSync(credsFile)) {
      console.log(
        `[BAILEYS] ${uniqueId} belum pernah ditautkan, restore dilewati.`,
      );
      continue;
    }
    try {
      const qr = await createClient(SHARED_BAZAR_KEY, slot);
      console.log(
        qr
          ? `[BAILEYS] ${uniqueId} butuh scan ulang.`
          : `[BAILEYS] ${uniqueId} dipulihkan.`,
      );
    } catch (e) {
      console.error(`[BAILEYS] Restore ${uniqueId} gagal:`, e.message);
    }
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
    const idleMs = Date.now() - (lastSentAt[uniqueId] || 0);

    // Kalau sudah lama menganggur, hitungan istirahat mulai dari nol
    if (idleMs > 5 * 60 * 1000) {
      sinceRest[uniqueId] = 0;
    }

    if ((sinceRest[uniqueId] || 0) >= REST_EVERY) {
      sinceRest[uniqueId] = 0;
      await randomDelay(REST_MIN_MS, REST_MAX_MS);
    } else {
      const gap = GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
      const wait = gap - idleMs;
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
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

let rrCursor = 0;

// Pilih nomor pengirim: yang tersambung, belum kena batas harian,
// dengan beban paling sedikit. Seri -> bergantian.
const pickSender = (storeCode) => {
  const ids = isBazarBranch(storeCode)
    ? SHARED_SLOTS.map((s) => getUniqueId(storeCode, s))
    : [getUniqueId(storeCode)];

  const live = ids.filter((id) => clients[id]?.user);
  if (live.length === 0) {
    return {
      error: "WA belum terhubung. Hubungi admin untuk menautkan ulang.",
    };
  }

  const underLimit = live.filter(
    (id) => getDailyCount(id) + (pendingCount[id] || 0) < DAILY_LIMIT,
  );
  if (underLimit.length === 0) {
    return {
      error: `Batas kirim WA hari ini (${DAILY_LIMIT} struk per nomor) sudah tercapai. Coba lagi besok.`,
    };
  }

  const open = underLimit.filter((id) => (pendingCount[id] || 0) < MAX_QUEUE);
  if (open.length === 0) {
    return { error: "Antrean pengiriman penuh, coba lagi sebentar." };
  }

  rrCursor += 1;
  let best = null;
  let bestLoad = Infinity;
  for (let i = 0; i < open.length; i += 1) {
    const id = open[(rrCursor + i) % open.length];
    const load = getDailyCount(id) + (pendingCount[id] || 0);
    if (load < bestLoad) {
      best = id;
      bestLoad = load;
    }
  }
  return { uniqueId: best };
};

const deliver = async ({
  storeCode,
  number,
  jenis,
  caption,
  meta,
  buildContent,
}) => {
  const id = normalizeNumber(number);
  const jid = id + "@s.whatsapp.net";

  const picked = pickSender(storeCode);
  if (picked.error) {
    return { success: false, error: picked.error };
  }
  const uniqueId = picked.uniqueId;

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
      getDailyCount(uniqueId);
      sendStats[uniqueId].count += 1;
      sinceRest[uniqueId] = (sinceRest[uniqueId] || 0) + 1;
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
    buildContent: () => ({ image: fileBuffer, caption: varyCaption(caption) }),
  });

/**
 * Hapus Sesi
 */
const deleteSession = async (storeCode, slot) => {
  const uniqueId = getUniqueId(storeCode, slot);
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
  delete connectedSince[uniqueId];
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
