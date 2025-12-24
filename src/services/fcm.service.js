const admin = require("../config/firebaseConfig");

const sendNotificationToDevice = async (
  fcmToken,
  title,
  body,
  dataPayload = {}
) => {
  if (!fcmToken) return;

  const message = {
    token: fcmToken,
    notification: {
      title: title,
      body: body,
    },
    // Data tambahan untuk logika di HP (misal: buka halaman approval, warna kartu, dll)
    data: {
      click_action: "FLUTTER_NOTIFICATION_CLICK", // Standar umum
      ...dataPayload, // { jenis: 'DISKON', transaksi: 'SO-001', ... }
    },
    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "default",
      },
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(
      `[FCM] Notif terkirim ke ${fcmToken.substr(0, 10)}...:`,
      response
    );
    return true;
  } catch (error) {
    console.error("[FCM] Gagal kirim notif:", error.message);
    // Jika token expired (NotRegistered), bisa tambahkan logic hapus token dari DB disini
    return false;
  }
};

module.exports = { sendNotificationToDevice };
