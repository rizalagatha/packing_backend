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

    console.log("🔍 [Backend] Validasi Barcode");
    console.log("   📦 Barcode:", barcode);
    console.log("   🏢 Gudang:", gudang);
    console.log("   📋 SPK Nomor:", spk_nomor || "TIDAK ADA");

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
      console.log("   ❌ Barcode tidak ditemukan di database");
      return res.status(404).json({
        success: false,
        message: "Barcode tidak ditemukan atau barang tidak aktif.",
      });
    }

    const product = stokRows[0];
    console.log("   ✅ Barcode ditemukan:", product);

    // Jika scan pertama, tidak perlu validasi SPK
    if (!spk_nomor) {
      console.log("   ℹ️  Scan pertama, tidak ada validasi SPK");
      return res.status(200).json({ success: true, data: product });
    }

    // 2. DEBUGGING: Lihat semua item di SPK ini
    console.log("   🔍 Debug: Melihat semua item di SPK", spk_nomor);
    const debugQuery = `
      SELECT 
        spk.spkd_nomor,
        spk.spkd_kode,
        spk.spkd_ukuran,
        d.brgd_barcode
      FROM tspk_dc spk
      LEFT JOIN tbarangdc_dtl d ON d.brgd_kode = spk.spkd_kode 
                                AND d.brgd_ukuran = spk.spkd_ukuran
      WHERE spk.spkd_nomor = ?
      ORDER BY spk.spkd_kode, spk.spkd_ukuran;
    `;
    const [debugRows] = await pool.query(debugQuery, [spk_nomor]);
    console.log("   📊 Isi SPK:", JSON.stringify(debugRows, null, 2));

    // 3. VALIDASI: Cek apakah barcode ini ADA di SPK
    console.log("   🔍 Validasi: Cari barcode di SPK...");
    const spkCheckQuery = `
      SELECT 
        spk.spkd_nomor,
        spk.spkd_kode,
        spk.spkd_ukuran,
        d.brgd_barcode
      FROM tspk_dc spk
      JOIN tbarangdc_dtl d ON d.brgd_kode = spk.spkd_kode 
                           AND d.brgd_ukuran = spk.spkd_ukuran
      WHERE d.brgd_barcode = ? 
        AND spk.spkd_nomor = ?;
    `;
    const [spkCheckRows] = await pool.query(spkCheckQuery, [
      barcode,
      spk_nomor,
    ]);

    console.log("   📊 Hasil validasi:", JSON.stringify(spkCheckRows, null, 2));

    if (spkCheckRows.length > 0) {
      // SUKSES: Barcode ada di dalam SPK yang benar
      console.log("   ✅ Barcode valid untuk SPK ini");
      return res.status(200).json({ success: true, data: product });
    }

    // 4. GAGAL: Barcode tidak ada di SPK ini
    console.log("   ❌ Barcode TIDAK valid untuk SPK ini");

    // Cari SPK lain yang punya barcode ini
    const otherSpkQuery = `
      SELECT 
        spk.spkd_nomor,
        spk.spkd_kode,
        spk.spkd_ukuran
      FROM tspk_dc spk
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
      const otherSpk = otherSpkRows[0];
      errorMessage = `Peringatan: Barang ini milik SPK yang berbeda (${otherSpk.spkd_nomor}).`;
      console.log("   📋 Barcode milik SPK:", otherSpk.spkd_nomor);
      console.log("   📦 Detail:", JSON.stringify(otherSpk, null, 2));
    }

    console.log("   🚫 Error:", errorMessage);
    return res.status(409).json({ success: false, message: errorMessage });
  } catch (error) {
    console.error("❌ [Backend Error]:", error);
    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server.",
    });
  }
};

module.exports = {
  findByBarcode,
};
