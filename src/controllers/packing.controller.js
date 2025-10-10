const pool = require("../config/database");

/**
 * Membuat nomor packing baru dengan format PACK/YYYYMMDD/XXXX
 */
const generatePackingNumber = async (connection) => {
  const today = new Date();
  const year = String(today.getFullYear()).substring(2); // Ambil 2 digit tahun, misal: '25'
  const month = String(today.getMonth() + 1).padStart(2, "0"); // Ambil 2 digit bulan, misal: '09'
  const prefix = `PACK${year}${month}`; // Menjadi: PACK2509

  // Query untuk mencari nomor terakhir dengan prefix bulan dan tahun yang sama
  const query = `
    SELECT pack_nomor FROM tpacking 
    WHERE pack_nomor LIKE ? 
    ORDER BY pack_nomor DESC LIMIT 1
  `;

  const [rows] = await pool.query(query, [`${prefix}%`]);

  let nextSequence = 1;
  if (rows.length > 0) {
    const lastNumber = rows[0].pack_nomor;
    // Ambil bagian angka (5 digit terakhir) dan ubah menjadi integer
    const lastSequence = parseInt(lastNumber.substring(prefix.length), 10);
    nextSequence = lastSequence + 1;
  }

  // Gabungkan prefix dengan nomor urut 5 digit
  return `${prefix}${String(nextSequence).padStart(5, "0")}`;
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
    // Ambil parameter dari query string, beri nilai default
    const { startDate, endDate, page = 1, limit = 15 } = req.query;

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Filter startDate dan endDate diperlukan.",
        });
    }

    const offset = (page - 1) * limit;

    // Query untuk menghitung total data yang cocok (untuk paginasi)
    const countQuery = `
            SELECT COUNT(*) as total 
            FROM tpacking 
            WHERE pack_tanggal BETWEEN ? AND ?;
        `;
    const [countRows] = await pool.query(countQuery, [startDate, endDate]);
    const totalItems = countRows[0].total;

    // Query untuk mengambil data per halaman
    const dataQuery = `
            SELECT 
                p.pack_nomor, 
                p.pack_tanggal, 
                p.pack_spk_nomor
            FROM tpacking p 
            WHERE p.pack_tanggal BETWEEN ? AND ?
            ORDER BY p.created_at DESC 
            LIMIT ? OFFSET ?;
        `;

    const [rows] = await pool.query(dataQuery, [
      startDate,
      endDate,
      parseInt(limit),
      parseInt(offset),
    ]);

    res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalItems / limit),
        totalItems: totalItems,
      },
    });
  } catch (error) {
    console.error("Gagal mengambil riwayat packing:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mengambil riwayat packing." });
  }
};

const getPackingDetail = async (req, res) => {
  try {
    const { nomor } = req.params;

    // 1. Query untuk mengambil data header, sekarang digabung dengan tspk untuk dapat NAMA SPK
    const [headerRows] = await pool.query(
      `SELECT 
                p.pack_nomor, 
                p.pack_tanggal, 
                p.pack_spk_nomor, 
                spk.spk_nama AS pack_nama_spk
             FROM tpacking p
             LEFT JOIN tspk spk ON p.pack_spk_nomor = spk.spk_nomor
             WHERE p.pack_nomor = ?`,
      [nomor]
    );

    if (headerRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Nomor packing tidak ditemukan." });
    }
    const header = headerRows[0];

    // 2. Query untuk mengambil semua item (tidak berubah)
    const [itemRows] = await pool.query(
      "SELECT * FROM tpacking_dtl WHERE packd_pack_nomor = ?",
      [nomor]
    );

    // 3. Query BARU untuk membuat string "DETAIL UKURAN" secara otomatis
    const [ukuranRows] = await pool.query(
      `SELECT 
                GROUP_CONCAT(CONCAT(size, '=', total_qty) ORDER BY FIELD(size, 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL') SEPARATOR ' ') AS detail_ukuran
             FROM (
                 SELECT size, SUM(packd_qty) AS total_qty
                 FROM tpacking_dtl
                 WHERE packd_pack_nomor = ?
                 GROUP BY size
             ) AS subquery`,
      [nomor]
    );

    // 4. Gabungkan hasil query ukuran ke dalam data header
    header.detail_ukuran = ukuranRows[0].detail_ukuran || "";

    res.status(200).json({
      success: true,
      data: {
        header: header,
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

const searchPacking = async (req, res) => {
  try {
    const { term } = req.query;
    const searchTerm = `%${term || ""}%`;
    const query = `
      SELECT pack_nomor, pack_spk_nomor, pack_tanggal 
      FROM tpacking 
      WHERE pack_nomor LIKE ? OR pack_spk_nomor LIKE ?
      ORDER BY created_at DESC LIMIT 20;
    `;
    const [rows] = await pool.query(query, [searchTerm, searchTerm]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in searchPacking:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari data packing." });
  }
};

module.exports = {
  createPacking,
  getPackingHistory,
  getPackingDetail,
  searchPacking,
};
