const pool = require("../config/database");

const findSpkByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;
    const query = `
        SELECT DISTINCT 
            c.spkd_nomor, 
            d.spk_nama,
            d.spk_tanggal 
        FROM tbarangdc_dtl b 
          LEFT JOIN tspk_dc c ON b.brgd_kode = c.spkd_kode
          LEFT JOIN tspk d ON c.spkd_nomor = d.spk_nomor
        WHERE b.brgd_barcode = ?
        AND spk_close = 0 AND spk_aktif = 'Y';
    `;
    const [rows] = await pool.query(query, [barcode]);
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
