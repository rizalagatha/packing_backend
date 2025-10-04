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

module.exports = {
  createClient,
  sendMessageToStore,
  deleteSession,
  sendMessage,
};
