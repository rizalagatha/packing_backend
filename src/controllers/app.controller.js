const packageJson = require("../../package.json"); // Sesuaikan path-nya ke root folder

const getAppVersion = async (req, res) => {
  try {
    const appInfo = {
      latestVersion: packageJson.version, // Ambil otomatis dari package.json
      versionCode: 28, // Update angka ini setiap rilis baru di backend
      apkUrl: "http://103.94.238.252:3000/public/updates/app-release.apk",
      forceUpdate: false,
      releaseNotes:
        "Update fitur Bazaar K01, Penyesuaian Penjualan Mobile dengan Retail Web, dan Fitur Auto Updater",
    };
    res.status(200).json({ success: true, data: appInfo });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal cek update" });
  }
};

module.exports = { getAppVersion };
