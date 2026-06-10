const packageJson = require("../../package.json");

const getAppVersion = async (req, res) => {
  try {
    const appInfo = {
      latestVersion: packageJson.version, // Ambil otomatis dari package.json
      versionCode: 43, // Update angka ini setiap rilis baru di backend
      apkUrl: "http://103.94.238.252:3000/public/updates/app-release.apk",
      forceUpdate: false,
      // Ubah dari string tunggal menjadi Array
      releaseNotes: [
        "Menu baru Lost Order dan Riwayat Lost Order, digunakan untuk mencatat lost order dari customer",
        "Update Terima SJ untuk dapat menerima Accesories dan Obat di update Retail mendatang yang akan distok",
      ],
    };
    res.status(200).json({ success: true, data: appInfo });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal cek update" });
  }
};

module.exports = { getAppVersion };
