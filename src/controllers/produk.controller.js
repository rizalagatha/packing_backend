const pool = require('../config/database');

/**
 * Mencari produk berdasarkan barcode dan gudang
 */
const findByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const { gudang } = req.query;

    if (!gudang) {
      return res.status(400).json({ success: false, message: 'Parameter query "gudang" diperlukan.' });
    }

    // Query ini sama persis dengan yang Anda berikan
    const query = `
      SELECT
        d.brgd_barcode AS barcode,
        d.brgd_kode AS kode,
        TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
        d.brgd_ukuran AS ukuran,
        IFNULL((
          SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m 
          WHERE m.mst_aktif = 'Y' AND m.mst_cab = ? AND m.mst_brg_kode = d.brgd_kode AND m.mst_ukuran = d.brgd_ukuran
        ), 0) AS stok
      FROM tbarangdc_dtl d
      INNER JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
      WHERE h.brg_aktif = 0 AND d.brgd_barcode = ?;
    `;
    
    const [rows] = await pool.query(query, [gudang, barcode]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Barcode tidak ditemukan atau barang tidak aktif.' });
    }

    res.status(200).json({ success: true, data: rows[0] });

  } catch (error) {
    console.error('Error saat mencari barcode:', error);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
  }
};

module.exports = {
  findByBarcode,
};