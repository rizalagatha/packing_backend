const pool = require("../config/database");

/**
 * Membuat nomor packing baru dengan format PACK/YYYYMMDD/XXXX
 */
const generatePackingNumber = async (connection) => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const datePrefix = `PACK/${year}${month}${day}/`;

  // Cari nomor terakhir untuk hari ini
  const [rows] = await connection.query(
    "SELECT pack_nomor FROM tpacking WHERE pack_nomor LIKE ? ORDER BY pack_nomor DESC LIMIT 1",
    [`${datePrefix}%`]
  );

  let nextSequence = 1;
  if (rows.length > 0) {
    const lastNumber = rows[0].pack_nomor;
    const lastSequence = parseInt(lastNumber.split("/").pop(), 10);
    nextSequence = lastSequence + 1;
  }

  return `${datePrefix}${String(nextSequence).padStart(4, "0")}`;
};

/**
 * Logika untuk membuat sesi packing baru
 */
const createPacking = async (req, res) => {
  // Ambil user_kode dari token yang sudah di-decode oleh middleware
  const { kode: user_kode } = req.user;

  // Ambil data dari body request
  const { spk_nomor, items } = req.body;

  // Validasi input
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Data "items" harus berupa array dan tidak boleh kosong.',
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction(); // -> Mulai Transaksi

    // 1. Buat nomor packing unik
    const pack_nomor = await generatePackingNumber(connection);
    const pack_tanggal = new Date();

    // 2. Simpan data header ke tabel tpacking
    const packingHeader = {
      pack_nomor,
      pack_tanggal,
      pack_spk_nomor: spk_nomor,
      pack_user_kode: user_kode,
      pack_status: 1, // Langsung dianggap selesai
    };
    await connection.query(
      "INSERT INTO tpacking (pack_nomor, pack_tanggal, pack_spk_nomor, pack_user_kode, pack_status, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
      [pack_nomor, pack_tanggal, spk_nomor, user_kode, 1]
    );

    // 3. Siapkan dan simpan data detail ke tpacking_dtl
    const packingDetails = items.map((item) => [
      pack_nomor,
      item.barcode,
      item.qty,
      item.brg_kaosan,
      item.size,
    ]);
    await connection.query(
      "INSERT INTO tpacking_dtl (packd_pack_nomor, packd_barcode, packd_qty, packd_brg_kaosan, size) VALUES ?",
      [packingDetails]
    );

    // Jika semua query berhasil, commit transaksi
    await connection.commit(); // -> Simpan Perubahan

    res.status(201).json({
      success: true,
      message: "Sesi packing berhasil disimpan!",
      data: {
        pack_nomor: pack_nomor,
      },
    });
  } catch (error) {
    // Jika ada error, batalkan semua perubahan
    if (connection) await connection.rollback(); // -> Batalkan Perubahan

    console.error("Gagal menyimpan data packing:", error);
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server.",
    });
  } finally {
    // Selalu lepaskan koneksi setelah selesai
    if (connection) connection.release();
  }
};

const getPackingHistory = async (req, res) => {
  try {
    const { kode: user_kode } = req.user;

    const query = `
      SELECT pack_nomor, pack_tanggal, pack_spk_nomor,
      (SELECT COUNT(*) FROM tpacking_dtl WHERE packd_pack_nomor = p.pack_nomor) as jumlah_item
      FROM tpacking p 
      WHERE p.pack_user_kode = ? 
      ORDER BY p.created_at DESC 
      LIMIT 5
    `;

    const [rows] = await pool.query(query, [user_kode]);

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Gagal mengambil riwayat packing:", error);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server." });
  }
};

const getPackingDetail = async (req, res) => {
  try {
    const { nomor } = req.params; // Ambil nomor packing dari URL

    // Ambil data header
    const [headerRows] = await pool.query(
      "SELECT pack_nomor, pack_tanggal, pack_spk_nomor, pack_user_kode FROM tpacking WHERE pack_nomor = ?",
      [nomor]
    );

    if (headerRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Nomor packing tidak ditemukan." });
    }

    // Ambil data item detail
    const [itemRows] = await pool.query(
      "SELECT * FROM tpacking_dtl WHERE packd_pack_nomor = ?",
      [nomor]
    );

    res.status(200).json({
      success: true,
      data: {
        header: headerRows[0],
        items: itemRows,
      },
    });
  } catch (error) {
    console.error("Gagal mengambil detail packing:", error);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server." });
  }
};

module.exports = {
  createPacking,
  getPackingHistory,
  getPackingDetail,
};
