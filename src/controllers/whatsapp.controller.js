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

const getSessionActivity = async (req, res) => {
  try {
    const sessionKey = whatsappService.getUniqueId(req.user.cabang);
    const [rows] = await pool.query(
      `SELECT user_kode, cabang, COUNT(*) AS total,
              SUM(status = 'OK') AS ok, MAX(created_at) AS last_at
       FROM twa_send_log
       WHERE session_key = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY user_kode, cabang
       ORDER BY last_at DESC`,
      [sessionKey],
    );
    const senders = rows.map((r) => ({
      user_kode: r.user_kode,
      cabang: r.cabang,
      total: Number(r.total) || 0,
      ok: Number(r.ok) || 0,
      last_at: r.last_at,
    }));
    const total = senders.reduce((sum, r) => sum + r.total, 0);
    const ok = senders.reduce((sum, r) => sum + r.ok, 0);
    res.status(200).json({
      success: true,
      data: { total, ok, gagal: total - ok, senders },
    });
  } catch (error) {
    console.error("Error getSessionActivity:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memuat aktivitas sesi." });
  }
};

module.exports = {
  getQrCode,
  logout,
  getSessionStatus,
  getSendLog,
  getSessionActivity,
};
