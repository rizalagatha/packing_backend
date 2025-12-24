// test-fcm.js
const admin = require("firebase-admin");

// 1. Pastikan path ini mengarah ke file json yang Anda download dari Firebase Console tadi
const serviceAccount = require("./src/config/service-account.json");

// 2. Token HP Anda (yang tadi Anda copy dari log)
const MY_DEVICE_TOKEN =
  "fVuB-wZAQ9iNyBEjp93HzA:APA91bH83x9rKxpGtnbJsN3qiK7ma6fcobizHFos9d_apY6vRLCGggE1iL8Mkt_QS17Cn5dDpWLjuSU_cqN7tutdNxyu_rcw3CCx1s95qZcNjjtTohS287o";

// Inisialisasi
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const sendTestNotification = async () => {
  const message = {
    token: MY_DEVICE_TOKEN,
    notification: {
      title: "🔥 Tes Masuk!",
      body: "Halo Manager, ini notifikasi percobaan dari Backend.",
    },
    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "default", // Default channel
      },
    },
    data: {
      jenis: "TEST_PING",
      transaksi: "INV-001",
    },
  };

  try {
    console.log("Mengirim pesan...");
    const response = await admin.messaging().send(message);
    console.log("SUKSES! Pesan terkirim:", response);
  } catch (error) {
    console.error("GAGAL kirim:", error);
  }
};

sendTestNotification();
