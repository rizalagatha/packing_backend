const whatsappService = require("../services/whatsapp.service");
const pool = require("../config/database");

const WA_ADMINS = (process.env.WA_BAZAR_ADMINS || "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const FORBIDDEN_MSG = "Hanya admin yang boleh menautkan atau memutus WA bazar.";

// Sesi cabang biasa: perilaku lama. Sesi bersama bazar: hanya admin.
const canManageSession = (user) => {
  if (!whatsappService.isSharedBranch(user.cabang)) {
    return true;
  }
  return WA_ADMINS.includes(String(user.kode || "").toUpperCase());
};

const getQrCode = async (req, res) => {
  try {
    const storeCode = req.user.cabang;

    if (!canManageSession(req.user)) {
      const info = await whatsappService.getSessionInfo(storeCode);
      if (info.status === "CONNECTED") {
        return res.status(200).json({ success: true, data: { qr: null } });
      }
      return res.status(403).json({ success: false, message: FORBIDDEN_MSG });
    }

    const qr = await whatsappService.createClient(storeCode);
    res.status(200).json({ success: true, data: { qr } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal membuat QR Code." });
  }
};

const logout = async (req, res) => {
  try {
    if (!canManageSession(req.user)) {
      return res.status(403).json({ success: false, message: FORBIDDEN_MSG });
    }
    const storeCode = req.user.cabang;
    await whatsappService.deleteSession(storeCode);
    res
      .status(200)
      .json({ success: true, message: "Sesi WhatsApp berhasil dihapus." });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal menghapus sesi." });
  }
};

const getSessionStatus = async (req, res) => {
  try {
    const storeCode = req.user.cabang;
    const sessionData = await whatsappService.getSessionInfo(storeCode);
    res.status(200).json({ success: true, data: sessionData });
  } catch (error) {
    console.error("Error getting session status:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mengambil status sesi." });
  }
};

const getSendLog = async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      300,
    );
    const sessionKey = whatsappService.getUniqueId(req.user.cabang);
    const [rows] = await pool.query(
      `SELECT id, cabang, user_kode, target, jenis, caption, status, error_msg, created_at
       FROM twa_send_log
       WHERE session_key = ?
       ORDER BY id DESC
       LIMIT ?`,
      [sessionKey, limit],
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error getSendLog:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat riwayat kirim." });
  }
};

module.exports = {
  getQrCode,
  logout,
  getSessionStatus,
  getSendLog,
};
