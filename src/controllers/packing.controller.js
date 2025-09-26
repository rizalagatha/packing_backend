const pool = require('../config/database');

/**
 * Membuat nomor packing baru dengan format PACK/YYYYMMDD/XXXX
 */
const generatePackingNumber = async (connection) => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const datePrefix = `PACK/${year}${month}${day}/`;

  // Cari nomor terakhir untuk hari ini
  const [rows] = await connection.query(
    "SELECT pack_nomor FROM tpacking WHERE pack_nomor LIKE ? ORDER BY pack_nomor DESC LIMIT 1",
    [`${datePrefix}%`]
  );

  let nextSequence = 1;
  if (rows.length > 0) {
    const lastNumber = rows[0].pack_nomor;
    const lastSequence = parseInt(lastNumber.split('/').pop(), 10);
    nextSequence = lastSequence + 1;
  }

  return `${datePrefix}${String(nextSequence).padStart(4, '0')}`;
};


/**
 * Logika untuk membuat sesi packing baru
 */
const createPacking = async (req, res) => {
  // Ambil user_kode dari token yang sudah di-decode oleh middleware
  const { kode: user_kode } = req.user;
  
  // Ambil data dari body request
  const { keterangan, items } = req.body;

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
      pack_keterangan: keterangan || null,
      pack_user_kode: user_kode,
      pack_status: 1, // Langsung dianggap selesai
    };
    await connection.query('INSERT INTO tpacking SET ?', packingHeader);

    // 3. Siapkan dan simpan data detail ke tpacking_dtl
    const packingDetails = items.map(item => [
      pack_nomor,
      item.barcode,
      item.qty,
      item.brg_kaosan,
      item.size
    ]);
    await connection.query(
      'INSERT INTO tpacking_dtl (packd_pack_nomor, packd_barcode, packd_qty, packd_brg_kaosan, size) VALUES ?',
      [packingDetails]
    );

    // Jika semua query berhasil, commit transaksi
    await connection.commit(); // -> Simpan Perubahan

    res.status(201).json({
      success: true,
      message: 'Sesi packing berhasil disimpan!',
      data: {
        pack_nomor: pack_nomor,
      },
    });

  } catch (error) {
    // Jika ada error, batalkan semua perubahan
    if (connection) await connection.rollback(); // -> Batalkan Perubahan
    
    console.error('Gagal menyimpan data packing:', error);
    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server.',
    });

  } finally {
    // Selalu lepaskan koneksi setelah selesai
    if (connection) connection.release();
  }
};

module.exports = {
  createPacking,
};