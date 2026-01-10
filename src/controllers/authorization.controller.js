const pool = require("../config/database");

// [MANAGER/STORE] Mengambil daftar request yang pending (status = 'P')
const getPendingRequests = async (req, res) => {
  try {
    const user = req.user;
    let query = "";
    let params = [];

    // --- PERBAIKAN LOGIKA SQL DI SINI ---

    if (user.cabang === "KDC") {
      // 1. LOGIKA MANAGER (KDC):
      // Hanya melihat request yang bersifat UMUM (Internal) atau TARGETNYA KDC.
      // Jangan tampilkan request yang ditujukan khusus ke Toko lain (o_target = 'K01', dll).
      query = `
        SELECT * FROM totorisasi 
        WHERE o_status = 'P' 
          AND (o_target IS NULL OR o_target = '' OR o_target = 'KDC')
        ORDER BY o_created DESC
      `;
    } else {
      // 2. LOGIKA USER TOKO (K01, dll):
      // Melihat request jika:
      // A. Request DITUJUKAN ke saya (o_target = 'K01') -> Kasus Ambil Barang
      // B. Request DIBUAT oleh saya (o_cab = 'K01') -> Kasus Otorisasi Internal
      query = `
        SELECT * FROM totorisasi 
        WHERE o_status = 'P' 
          AND (o_target = ? OR (o_cab = ? AND (o_target IS NULL OR o_target = '')))
        ORDER BY o_created DESC
      `;
      // Kita perlu push user.cabang dua kali untuk mengisi dua tanda tanya (?) di atas
      params.push(user.cabang, user.cabang);
    }

    // Debugging (Opsional: Cek di terminal backend)
    // console.log("User:", user.kode, "Cabang:", user.cabang);
    // console.log("Query:", query);
    // console.log("Params:", params);

    const [rows] = await pool.query(query, params);

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
      today >= new Date(2026, 0, 10) && today < new Date(2026, 0, 17);

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
