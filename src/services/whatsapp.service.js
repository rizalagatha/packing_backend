const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const SESSION_DIR = path.join(__dirname, "../../.wwebjs_auth");

// Objek untuk menampung semua instance client, di-key berdasarkan kode store
const clients = {};

const SENDER_CLIENT_ID = "KDC";

/**
 * Membuat dan menginisialisasi client baru untuk sebuah store.
 * Mengembalikan Promise yang akan resolve dengan QR code string.
 */
const createClient = (storeCode) => {
  return new Promise((resolve, reject) => {
    console.log(`Membuat client untuk store: ${storeCode}`);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: storeCode }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
      },
    });

    client.on("qr", (qr) => {
      console.log(`QR Code untuk ${storeCode} diterima.`);
      // Jangan generate di terminal, tapi kirim string QR-nya
      resolve(qr);
    });

    client.on("ready", () => {
      console.log(`✅ Client untuk ${storeCode} sudah siap!`);
      clients[storeCode] = client; // Simpan client yang sudah siap
    });

    client.on("auth_failure", (msg) => {
      console.error(`Autentikasi GAGAL untuk ${storeCode}:`, msg);
      reject(new Error("Authentication failed"));
    });

    client.initialize();
  });
};

/**
 * Mengirim pesan DARI PENGIRIM UTAMA (KDC) KE store tujuan.
 */
const sendMessageToStore = async (recipientStoreCode, message) => {
  const senderClient = clients[SENDER_CLIENT_ID];
  const recipientClient = clients[recipientStoreCode];

  if (!senderClient || (await senderClient.getState()) !== "CONNECTED") {
    console.warn(`Client PENGIRIM (${SENDER_CLIENT_ID}) tidak siap.`);
    return { success: false, error: "Sender client not ready" };
  }

  if (!recipientClient) {
    console.warn(
      `Tidak ada sesi WhatsApp aktif untuk store PENERIMA (${recipientStoreCode}).`
    );
    return { success: false, error: "Recipient client not found" };
  }

  const recipientNumber = recipientClient.info.wid.user;
  const chatId = `${recipientNumber}@c.us`;

  try {
    await senderClient.sendMessage(chatId, message);
    console.log(
      `Pesan terkirim dari ${SENDER_CLIENT_ID} ke ${recipientStoreCode} (${recipientNumber})`
    );
    return { success: true };
  } catch (error) {
    console.error(`Gagal mengirim pesan ke ${recipientStoreCode}:`, error);
    return { success: false, error };
  }
};

/**
 * Menghapus sesi untuk sebuah store
 */
const deleteSession = async (storeCode) => {
  const client = clients[storeCode];
  if (client) {
    await client.destroy(); // Hentikan client
    delete clients[storeCode];
  }
  // Hapus folder sesi dari disk
  const sessionPath = path.join(SESSION_DIR, `session-${storeCode}`);
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }
  console.log(`Sesi untuk ${storeCode} telah dihapus.`);
  return { success: true };
};

/**
 * Mengirim pesan ke nomor manapun menggunakan client pengirim utama (KDC).
 */
const sendMessage = async (number, message) => {
  const senderClient = clients[SENDER_CLIENT_ID];

  if (senderClient && (await senderClient.getState()) === "CONNECTED") {
    const chatId = `${number}@c.us`;
    try {
      await senderClient.sendMessage(chatId, message);
      console.log(`Pesan terkirim ke ${number} via client ${SENDER_CLIENT_ID}`);
      return { success: true };
    } catch (error) {
      console.error(`Gagal mengirim pesan ke ${number}:`, error);
      return { success: false, error };
    }
  } else {
    console.warn(
      `Client PENGIRIM (${SENDER_CLIENT_ID}) tidak siap atau tidak ditemukan.`
    );
    return {
      success: false,
      error: `Sender client '${SENDER_CLIENT_ID}' not ready`,
    };
  }
};

/**
 * Mendapatkan informasi status sesi untuk sebuah store
 */
const getSessionInfo = async (storeCode) => {
  const client = clients[storeCode];

  if (!client) {
    return { status: 'DISCONNECTED', info: null };
  }

  try {
    const state = await client.getState();
    if (state === 'CONNECTED') {
      const info = client.info;
      return {
        status: 'CONNECTED',
        info: {
          pushname: info.pushname,
          wid: info.wid, // Contains user (number), server, etc.
          platform: info.platform
        }
      };
    } else {
      return { status: state || 'DISCONNECTED', info: null };
    }
  } catch (error) {
    // If client exists but getState fails (e.g. during initialization), assume initializing or disconnected
    return { status: 'INITIALIZING', info: null };
  }
};

/**
 * Mengirim pesan DARI spesifik store ke nomor pelanggan
 */
const sendMessageFromClient = async (storeCode, number, message) => {
  // 1. Ambil client milik store tersebut
  const client = clients[storeCode];

  // 2. Validasi Client
  if (!client) {
    return { 
      success: false, 
      error: `WA Store ${storeCode} belum terhubung. Silakan scan QR di menu Pengaturan.` 
    };
  }

  try {
    // Cek status koneksi (opsional, kadang getState throw error di puppeteer lama)
    // const state = await client.getState();
    // if (state !== 'CONNECTED') throw new Error("WA tidak terhubung.");

    // 3. Format Nomor (Hilangkan 0 atau +62 depan, ganti 62)
    let formattedNumber = number.toString().replace(/\D/g, ''); // Hapus karakter non-angka
    if (formattedNumber.startsWith('0')) {
      formattedNumber = '62' + formattedNumber.slice(1);
    }
    if (!formattedNumber.endsWith('@c.us')) {
      formattedNumber += '@c.us';
    }

    // 4. Kirim Pesan
    await client.sendMessage(formattedNumber, message);
    console.log(`[WA] Pesan terkirim dari ${storeCode} ke ${number}`);
    return { success: true };

  } catch (error) {
    console.error(`[WA Error] ${storeCode} -> ${number}:`, error);
    return { success: false, error: "Gagal mengirim pesan. Pastikan WA aktif." };
  }
};

module.exports = {
  createClient,
  sendMessageToStore,
  deleteSession,
  sendMessage,
  getSessionInfo,
  sendMessageFromClient,
};
