const pool = require("../config/database");

/**
 * 1. Membuat Catatan Lost Order Baru
 */
const createLostOrder = async (req, res) => {
  try {
    const user = req.user; // Dari token auth
    const {
      customerNama,
      customerTelp,
      produkNama,
      ukuran,
      qty,
      alasan,
      catatan,
    } = req.body;

    // Validasi input wajib
    if (!produkNama || !ukuran || !qty) {
      return res.status(400).json({
        success: false,
        message: "Nama produk, ukuran, dan QTY wajib diisi.",
      });
    }

    const query = `
      INSERT INTO tlost_order 
      (lo_cabang, lo_customer_nama, lo_customer_telp, lo_produk_nama, lo_ukuran, lo_qty, lo_alasan, lo_catatan, user_create, date_create) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;

    const values = [
      user.cabang, // Ambil otomatis dari sesi login kasir/SC
      customerNama || null,
      customerTelp || null,
      produkNama,
      ukuran,
      parseInt(qty, 10),
      alasan || null,
      catatan || null,
      user.kode,
    ];

    const [result] = await pool.query(query, values);

    res.status(201).json({
      success: true,
      message: "Data Lost Order berhasil dicatat.",
      data: { insertId: result.insertId },
    });
  } catch (error) {
    console.error("Error createLostOrder:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal menyimpan data Lost Order." });
  }
};

/**
 * 2. Mengambil Riwayat Lost Order (Untuk Dashboard / Rekap)
 */
const getLostOrders = async (req, res) => {
  try {
    const user = req.user;
    const { startDate, endDate, page = 1, limit = 20 } = req.query;

    let baseQuery = `FROM tlost_order WHERE 1=1`;
    let params = [];

    // Filter by cabang jika bukan user pusat/KDC
    if (user.cabang !== "KDC") {
      baseQuery += ` AND lo_cabang = ?`;
      params.push(user.cabang);
    }

    // Filter tanggal jika ada
    if (startDate && endDate) {
      baseQuery += ` AND DATE(lo_tanggal) BETWEEN ? AND ?`;
      params.push(startDate, endDate);
    }

    // Ambil total data
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total ${baseQuery}`,
      params,
    );
    const totalItems = countRows[0].total;

    // Ambil data dengan paginasi
    const offset = (page - 1) * limit;
    const dataQuery = `
      SELECT 
        lo_id, lo_tanggal, lo_cabang, lo_customer_nama, lo_customer_telp,
        lo_produk_nama, lo_ukuran, lo_qty, lo_alasan, lo_catatan, user_create
      ${baseQuery}
      ORDER BY lo_tanggal DESC
      LIMIT ? OFFSET ?
    `;

    params.push(parseInt(limit), parseInt(offset));
    const [rows] = await pool.query(dataQuery, params);

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
    console.error("Error getLostOrders:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mengambil data Lost Order." });
  }
};

module.exports = {
  createLostOrder,
  getLostOrders,
};
