const pool = require("../config/database");

// [MANAGER] Mengambil daftar request yang pending (status = 'P')
const getPendingRequests = async (req, res) => {
  try {
    const user = req.user; 
    let query = "";
    let params = [];

    // Logika: Jika user KDC (Pusat), lihat semua. 
    // Jika cabang, hanya lihat cabang sendiri.
    if (user.cabang === "KDC") {
      query = `
        SELECT * FROM totorisasi 
        WHERE o_status = 'P' 
        ORDER BY o_created DESC
      `;
    } else {
      query = `
        SELECT * FROM totorisasi 
        WHERE o_status = 'P' AND o_cab = ? 
        ORDER BY o_created DESC
      `;
      params.push(user.cabang);
    }

    const [rows] = await pool.query(query, params);

    // [PENTING] Kembalikan array kosong [] jika tidak ada data, jangan null/error
    res.status(200).json({
      success: true,
      data: rows || [], 
    });

  } catch (error) {
    console.error("Error getPendingRequests:", error);
    res.status(500).json({
      success: false,
      message: "Gagal memuat data otorisasi.",
    });
  }
};

// [MANAGER] Melakukan Approve atau Reject
const processRequest = async (req, res) => {
  const { authNomor, action } = req.body; // action: 'APPROVE' | 'REJECT'
  const user = req.user;

  if (!authNomor || !["APPROVE", "REJECT"].includes(action)) {
    return res.status(400).json({
      success: false,
      message: "Data proses tidak valid (Nomor atau Action salah).",
    });
  }

  try {
    // Tentukan status baru: 
    // 'Y' = Approved (Yes)
    // 'N' = Rejected (No)
    const newStatus = action === "APPROVE" ? 'Y' : 'N';

    // [FIX] Update status dan approver.
    // Hapus update o_pin untuk menghindari error data too long.
    // Pastikan hanya mengupdate data yang statusnya masih 'P' (Pending)
    const query = `
        UPDATE totorisasi 
        SET o_status = ?, o_approver = ?, o_approved_at = NOW()
        WHERE o_nomor = ? AND o_status = 'P'
    `;

    const [result] = await pool.query(query, [newStatus, user.nama, authNomor]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Gagal memproses. Request mungkin sudah diproses atau tidak ditemukan.",
      });
    }

    res.status(200).json({
      success: true,
      message: `Otorisasi berhasil di-${action === "APPROVE" ? "setujui" : "tolak"}.`,
    });
  } catch (error) {
    console.error("Error processRequest:", error);
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat memproses otorisasi.",
    });
  }
};

module.exports = {
  getPendingRequests,
  processRequest,
};