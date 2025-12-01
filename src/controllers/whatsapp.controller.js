const whatsappService = require("../services/whatsapp.service");

const getQrCode = async (req, res) => {
  try {
    const storeCode = req.user.cabang; // Ambil kode store dari user yang login
    const qr = await whatsappService.createClient(storeCode);
    res.status(200).json({ success: true, data: { qr } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal membuat QR Code." });
  }
};

const logout = async (req, res) => {
  try {
    const storeCode = req.user.cabang;
    await whatsappService.deleteSession(storeCode);
    res
      .status(200)
      .json({ success: true, message: "Sesi WhatsApp berhasil dihapus." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal menghapus sesi." });
  }
};

module.exports = {
  getQrCode,
  logout,
};
