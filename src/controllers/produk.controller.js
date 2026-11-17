const pool = require("../config/database");

const findByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const { gudang, spk_nomor } = req.query;

    if (!gudang) {
      return res
        .status(400)
        .json({ success: false, message: 'Parameter "gudang" diperlukan.' });
    }

    // 1. Cek barcode dan ambil data
    const stokQuery = `
      SELECT
        d.brgd_barcode AS barcode, 
        d.brgd_kode AS kode,
        TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
        d.brgd_ukuran AS ukuran,
        IFNULL((
          SELECT SUM(m.mst_stok_in - m.mst_stok_out) 
          FROM tmasterstok m 
          WHERE m.mst_aktif = 'Y' 
            AND m.mst_cab = ? 
            AND m.mst_brg_kode = d.brgd_kode 
            AND m.mst_ukuran = d.brgd_ukuran
        ), 0) AS stok
      FROM tbarangdc_dtl d
      LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
      WHERE h.brg_aktif = 0 AND d.brgd_barcode = ?;
    `;
    const [stokRows] = await pool.query(stokQuery, [gudang, barcode]);

    if (stokRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Barcode tidak ditemukan atau barang tidak aktif.",
      });
    }

    const product = stokRows[0];

    // Jika scan pertama, tidak perlu validasi SPK
    if (!spk_nomor) {
      return res.status(200).json({ success: true, data: product });
    }

    // 2. VALIDASI: barcode harus ada di SPK, atau kode BS yang berasal dari SPK ini
    const spkCheckQuery = `
      SELECT spk.spkd_nomor
      FROM kencanaprint.tspk_dc spk
      JOIN tbarangdc_dtl d ON d.brgd_kode = spk.spkd_kode
                           AND d.brgd_ukuran = spk.spkd_ukuran
      WHERE d.brgd_barcode = ?
        AND spk.spkd_nomor = ?

      UNION ALL

      SELECT k.bsk_spk_nomor AS spkd_nomor
      FROM kencanaprint.tbarcode_bs_kode k
      WHERE k.bsk_kode_bs = ?
        AND k.bsk_spk_nomor = ?;
    `;
    const [spkCheckRows] = await pool.query(spkCheckQuery, [
      barcode,
      spk_nomor,
      barcode,
      spk_nomor,
    ]);

    if (spkCheckRows.length > 0) {
      return res.status(200).json({ success: true, data: product });
    }

    // 3. GAGAL: cari SPK lain yang punya barcode ini
    const otherSpkQuery = `
      SELECT spk.spkd_nomor
      FROM kencanaprint.tspk_dc spk
      JOIN tbarangdc_dtl d ON d.brgd_kode = spk.spkd_kode 
                           AND d.brgd_ukuran = spk.spkd_ukuran
      WHERE d.brgd_barcode = ? 
        AND spk.spkd_nomor <> ?
      LIMIT 1;
    `;
    const [otherSpkRows] = await pool.query(otherSpkQuery, [
      barcode,
      spk_nomor,
    ]);

    let errorMessage = `Barcode tidak ditemukan di dalam SPK ${spk_nomor}.`;
    if (otherSpkRows.length > 0) {
      errorMessage = `Peringatan: Barang ini milik SPK yang berbeda (${otherSpkRows[0].spkd_nomor}).`;
    }

    return res.status(409).json({ success: false, message: errorMessage });
  } catch (error) {
    console.error("[findByBarcode] Error:", error);
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server.",
    });
  }
};
module.exports = {
  findByBarcode,
};
