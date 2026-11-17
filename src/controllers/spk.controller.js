const pool = require("../config/database");

const findSpkByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const query = `
      SELECT DISTINCT
          c.spkd_nomor,
          d.spk_nama,
          d.spk_tanggal,
          c.spkd_qtyorder AS qty_order,
          d.spk_close
      FROM tbarangdc_dtl b
        JOIN kencanaprint.tspk_dc c ON b.brgd_kode = c.spkd_kode
        JOIN kencanaprint.tspk d ON c.spkd_nomor = d.spk_nomor
      WHERE b.brgd_barcode = ?

      UNION

      SELECT
          k.bsk_spk_nomor AS spkd_nomor,
          s.spk_nama,
          s.spk_tanggal,
          IFNULL(dc.spkd_qtyorder, 0) AS qty_order,
          s.spk_close
      FROM kencanaprint.tbarcode_bs_kode k
        JOIN kencanaprint.tspk s ON s.spk_nomor = k.bsk_spk_nomor
        LEFT JOIN kencanaprint.tspk_dc dc
               ON dc.spkd_nomor = k.bsk_spk_nomor
              AND dc.spkd_kode = k.bsk_kode
              AND dc.spkd_ukuran = k.bsk_ukuran
      WHERE k.bsk_kode_bs = ?

      ORDER BY spk_tanggal DESC;
    `;
    const [rows] = await pool.query(query, [barcode, barcode]);
    res.status(200).json({ success: true, data: { items: rows } });
  } catch (error) {
    console.error("Error in findSpkByBarcode:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mencari data SPK." });
  }
};

module.exports = {
  findSpkByBarcode,
};
