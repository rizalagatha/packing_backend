const packageJson = require("../../package.json");
const { getStoreDirectoryText } = require("../services/storeDirectory.service");

const getAppVersion = async (req, res) => {
  try {
    const appInfo = {
      latestVersion: packageJson.version, // Ambil otomatis dari package.json
      versionCode: 77, // Update angka ini setiap rilis baru di backend
      apkUrl: "http://103.94.238.252:3000/public/updates/app-release.apk",
      forceUpdate: false,
      // Ubah dari string tunggal menjadi Array
      releaseNotes: ["Update untuk Pameran"],
    };
    res.status(200).json({ success: true, data: appInfo });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal cek update" });
  }
};

const getStoreDirectory = async (req, res) => {
  try {
    const text = await getStoreDirectoryText();
    res.status(200).json({ success: true, data: { text } });
  } catch (error) {
    console.error("Error getStoreDirectory:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat info toko." });
  }
};

module.exports = { getAppVersion, getStoreDirectory };
