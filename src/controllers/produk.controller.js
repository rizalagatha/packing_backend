const pool = require('../config/database');

/**
 * Mencari produk berdasarkan barcode dan gudang
 */
const findByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const { gudang, spk_nomor } = req.query;

    if (!gudang) {
      return res.status(400).json({ success: false, message: 'Parameter "gudang" diperlukan.' });
    }

    let query = `
      SELECT
        d.brgd_barcode AS barcode, d.brgd_kode AS kode,
        TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
        d.brgd_ukuran AS ukuran,
        IFNULL((
          SELECT SUM(m.mst_stok_in - m.mst_stok_out) FROM tmasterstok m 
          WHERE m.mst_aktif = 'Y' AND m.mst_cab = ? AND m.mst_brg_kode = d.brgd_kode AND m.mst_ukuran = d.brgd_ukuran
        ), 0) AS stok
      FROM tbarangdc_dtl d
      LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
    `;
    const params = [gudang];

    // Jika spk_nomor dikirim, tambahkan validasi ke SPK
    if (spk_nomor) {
      query += `
        JOIN kencanaprint.tspk_dc spk ON d.brgd_kode = spk.spkd_kode
        WHERE spk.spkd_nomor = ? AND d.brgd_barcode = ?
      `;
      params.push(spk_nomor, barcode);
    } else {
      query += ` WHERE h.brg_aktif = 0 AND d.brgd_barcode = ?`;
      params.push(barcode);
    }

    const [rows] = await pool.query(query, params);

    if (rows.length === 0) {
      let message = spk_nomor 
        ? `Barcode tidak ditemukan di dalam SPK ${spk_nomor}.`
        : 'Barcode tidak ditemukan atau barang tidak aktif.';
      return res.status(404).json({ success: false, message: message });
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