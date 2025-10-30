const pool = require("../config/database");

/**
 * Mencari produk berdasarkan barcode dan gudang
 */
const findByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const { gudang, spk_nomor } = req.query; // spk_nomor akan ada jika scan kedua dst.

    if (!gudang) {
      return res
        .status(400)
        .json({ success: false, message: 'Parameter "gudang" diperlukan.' });
    }

    // --- LOGIKA BARU UNTUK VALIDASI ---

    // 1. Cek dulu apakah barcode ada & ambil datanya (termasuk stok)
    const stokQuery = `
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
      WHERE h.brg_aktif = 0 AND d.brgd_barcode = ?;
    `;
    const [stokRows] = await pool.query(stokQuery, [gudang, barcode]);

    if (stokRows.length === 0) {
      // Jika barcode-nya sendiri tidak ada di database
      return res
        .status(404)
        .json({
          success: false,
          message: "Barcode tidak ditemukan atau barang tidak aktif.",
        });
    }

    // Jika ini scan pertama (belum ada SPK terkunci), kembalikan data barang.
    if (!spk_nomor) {
      return res.status(200).json({ success: true, data: stokRows[0] });
    }

    // 2. Jika SPK SUDAH TERKUNCI, validasi barcode ke SPK tersebut
    const spkCheckQuery = `
        SELECT COUNT(*) as count
        FROM tbarangdc_dtl d
        JOIN tspk_dc spk ON d.brgd_kode = spk.spkd_kode
        WHERE d.brgd_barcode = ? AND spk.spkd_nomor = ?;
    `;
    const [spkCheckRows] = await pool.query(spkCheckQuery, [
      barcode,
      spk_nomor,
    ]);

    if (spkCheckRows[0].count > 0) {
      // SUKSES: Barcode ada di dalam SPK yang benar.
      return res.status(200).json({ success: true, data: stokRows[0] });
    }

    // 3. GAGAL: Barcode tidak ada di SPK ini.
    // Sekarang, kita cari tahu barcode ini milik SPK mana.
    const otherSpkQuery = `
        SELECT spk.spkd_nomor
        FROM tbarangdc_dtl d
        JOIN tspk_dc spk ON d.brgd_kode = spk.spkd_kode
        WHERE d.brgd_barcode = ? AND spk.spkd_nomor <> ?
        LIMIT 1;
    `;
    const [otherSpkRows] = await pool.query(otherSpkQuery, [
      barcode,
      spk_nomor,
    ]);

    let errorMessage = `Barcode tidak ditemukan di dalam SPK ${spk_nomor}.`;
    if (otherSpkRows.length > 0) {
      // Jika kita menemukan SPK lain, berikan pesan error spesifik
      errorMessage = `Peringatan: Barang ini milik SPK yang berbeda (${otherSpkRows[0].spkd_nomor}).`;
    }

    // Kembalikan error 409 (Conflict)
    return res.status(409).json({ success: false, message: errorMessage });
  } catch (error) {
    console.error("Error saat mencari barcode:", error);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server." });
  }
};

module.exports = {
  findByBarcode,
};