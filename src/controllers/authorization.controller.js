const pool = require("../config/database");

// [MANAGER/STORE] Mengambil daftar request yang pending (status = 'P')
const getPendingRequests = async (req, res) => {
  try {
    const user = req.user;
    const userKodeUpper = String(user.kode).toUpperCase();
    const today = new Date();

    // Periode Pengalihan: 12 Jan s/d 16 Jan 2026
    const isEstuManagerPeriod =
      today >= new Date(2026, 0, 12) && today < new Date(2026, 0, 17);

    let query = "";
    let params = [];

    if (user.cabang === "KDC") {
      // --- LOGIKA FILTER UNTUK USER PUSAT ---

      if (userKodeUpper === "ESTU") {
        if (isEstuManagerPeriod) {
          // 12-16 JAN: Estu lihat SEMUA (Manager + Peminjaman)
          query = `SELECT * FROM totorisasi WHERE o_status = 'P' 
                   AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC' OR o_jenis = 'PEMINJAMAN_BARANG')`;
        } else {
          // NORMAL: Estu HANYA boleh lihat Peminjaman Barang
          query = `SELECT * FROM totorisasi WHERE o_status = 'P' AND o_jenis = 'PEMINJAMAN_BARANG'`;
        }
      } else if (userKodeUpper === "HARIS") {
        if (isEstuManagerPeriod) {
          // 12-16 JAN: Haris tidak melihat apa-apa (Menu kosong)
          query = `SELECT * FROM totorisasi WHERE 1=0`;
        } else {
          // NORMAL: Haris lihat semua transaksi Manager
          query = `SELECT * FROM totorisasi WHERE o_status = 'P' 
                   AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC')`;
        }
      } else {
        // User lain (misal DARUL): Tetap lihat semua transaksi Manager
        query = `SELECT * FROM totorisasi WHERE o_status = 'P' 
                 AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC' OR o_jenis = 'PEMINJAMAN_BARANG')`;
      }
    } else {
      // Logika User Toko tetap sama seperti sebelumnya
      query = `SELECT * FROM totorisasi WHERE o_status = 'P' 
               AND (o_target = ? OR (o_cab = ? AND (o_target IS NULL OR o_target = '')))`;
      params.push(user.cabang, user.cabang);
    }

    const [rows] = await pool.query(query, params);
    res.status(200).json({ success: true, data: rows || [] });
  } catch (error) {
    console.error("Error getPendingRequests:", error);
    res.status(500).json({ success: false, message: "Gagal memuat data." });
  }
};

// [MANAGER/STORE] Melakukan Approve atau Reject
const processRequest = async (req, res) => {
  const { authNomor, action } = req.body;
  const user = req.user;

  if (!authNomor || !["APPROVE", "REJECT"].includes(action)) {
    return res.status(400).json({
      success: false,
      message: "Data proses tidak valid (Nomor atau Action salah).",
    });
  }

  try {
    // 1. AMBIL DETAIL JENIS REQUEST DULU
    const [checkRows] = await pool.query(
      "SELECT o_jenis FROM totorisasi WHERE o_nomor = ?",
      [authNomor]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data otorisasi tidak ditemukan.",
      });
    }

    const o_jenis = checkRows[0].o_jenis;
    const userKodeUpper = String(user.kode).toUpperCase();
    const today = new Date();

    // Periode Pengalihan: 12 Jan s/d 16 Jan 2026
    const isEstuManagerPeriod =
      today >= new Date(2026, 0, 12) && today < new Date(2026, 0, 17);

    // 2. VALIDASI KEAMANAN BERDASARKAN ROLE & TANGGAL

    // A. Proteksi HARIS: Dilarang approve apapun selama periode 12-16 Jan
    if (isEstuManagerPeriod && userKodeUpper === "HARIS") {
      return res.status(403).json({
        success: false,
        message:
          "Hak otorisasi Manager sedang dialihkan ke ESTU hingga 16 Jan 2026.",
      });
    }

    // B. Proteksi ESTU:
    if (userKodeUpper === "ESTU") {
      const isPeminjaman = o_jenis === "PEMINJAMAN_BARANG";

      // Estu hanya boleh approve jika itu PEMINJAMAN_BARANG
      // ATAU jika sedang masuk periode manager (12-16 Jan)
      if (!isPeminjaman && !isEstuManagerPeriod) {
        return res.status(403).json({
          success: false,
          message:
            "Anda hanya berwenang untuk otorisasi Peminjaman Barang di luar periode 12-16 Jan.",
        });
      }
    }

    // 3. EKSEKUSI UPDATE KE DATABASE
    const newStatus = action === "APPROVE" ? "Y" : "N";
    const approverName = user.kode || user.nama;

    const query = `
        UPDATE totorisasi 
        SET o_status = ?, o_approver = ?, o_approved_at = NOW()
        WHERE o_nomor = ? AND o_status = 'P'
    `;

    const [result] = await pool.query(query, [
      newStatus,
      approverName,
      authNomor,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Gagal memproses. Request mungkin sudah diproses oleh manager lain.",
      });
    }

    res.status(200).json({
      success: true,
      message: `Otorisasi berhasil di-${
        action === "APPROVE" ? "setujui" : "tolak"
      }.`,
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
