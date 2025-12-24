const admin = require("firebase-admin");
const serviceAccount = require("./service-account.json"); // Pastikan path file JSON benar

// Cek agar tidak double initialize
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

module.exports = admin;
