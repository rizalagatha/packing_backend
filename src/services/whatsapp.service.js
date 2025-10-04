const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '../../.wwebjs_auth');

// Objek untuk menampung semua instance client, di-key berdasarkan kode store
const clients = {};

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
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      },
    });

    client.on('qr', (qr) => {
      console.log(`QR Code untuk ${storeCode} diterima.`);
      // Jangan generate di terminal, tapi kirim string QR-nya
      resolve(qr);
    });

    client.on('ready', () => {
      console.log(`✅ Client untuk ${storeCode} sudah siap!`);
      clients[storeCode] = client; // Simpan client yang sudah siap
    });

    client.on('auth_failure', (msg) => {
        console.error(`Autentikasi GAGAL untuk ${storeCode}:`, msg);
        reject(new Error('Authentication failed'));
    });

    client.initialize();
  });
};

/**
 * Mengirim pesan ke nomor default store.
 */
const sendMessageToStore = async (storeCode, message) => {
  const client = clients[storeCode];
  if (client && (await client.getState()) === 'CONNECTED') {
    // Nomor store diambil dari info client itu sendiri
    const storeNumber = client.info.wid.user;
    const chatId = `${storeNumber}@c.us`;
    try {
      await client.sendMessage(chatId, message);
      console.log(`Pesan terkirim ke store ${storeCode} (${storeNumber})`);
      return { success: true };
    } catch (error) {
      console.error(`Gagal mengirim pesan ke ${storeCode}:`, error);
      return { success: false, error };
    }
  } else {
    console.warn(`Client untuk store ${storeCode} tidak siap atau tidak ditemukan.`);
    return { success: false, error: 'Client not ready' };
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
}


module.exports = {
  createClient,
  sendMessageToStore,
  deleteSession,
};