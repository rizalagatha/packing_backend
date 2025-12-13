const pool = require("../config/database");

// 1. Download Master Barang (Untuk disimpan ke SQLite HP)
const downloadMasterBarang = async (req, res) => {
  try {
    const { cabang } = req.user;

    // Ambil data barang & stok saat ini
    const query = `
            SELECT 
                d.brgd_barcode AS barcode,
                d.brgd_kode AS kode,
                TRIM(CONCAT(h.brg_jeniskaos, " ", h.brg_tipe, " ", h.brg_lengan, " ", h.brg_jeniskain, " ", h.brg_warna)) AS nama,
                d.brgd_ukuran AS ukuran,
                d.brgd_lokasi AS lokasi,
                IFNULL((
                    SELECT SUM(m.mst_stok_in - m.mst_stok_out) 
                    FROM tmasterstok m 
                    WHERE m.mst_aktif='Y' AND m.mst_cab=? AND m.mst_brg_kode=d.brgd_kode AND m.mst_ukuran=d.brgd_ukuran
                ), 0) AS stok_sistem
            FROM tbarangdc_dtl d
            LEFT JOIN tbarangdc h ON h.brg_kode = d.brgd_kode
            WHERE h.brg_aktif=0 AND h.brg_logstok <> 'N';
        `;

    const [rows] = await pool.query(query, [cabang]);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error downloadMasterBarang:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mendownload data barang." });
  }
};

// 2. Upload Hasil Opname (Dari SQLite HP ke Server)
const uploadHasilOpname = async (req, res) => {
  const { items } = req.body; // Array hasil scan dari SQLite
  const user = req.user;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Simpan ke tabel temporary atau tabel hasil opname (sesuaikan dengan struktur DB Anda)
    // Misal: tstokopname_temp
    const insertQuery = `
            INSERT INTO tstokopname_temp (so_cab, so_user, so_tanggal, so_barcode, so_kode, so_qty_fisik, so_qty_sistem, date_create)
            VALUES ?
        `;

    const values = items.map((item) => [
      user.cabang,
      user.kode,
      new Date(),
      item.barcode,
      item.kode,
      item.qty_fisik,
      item.stok_sistem, // Opsional, untuk perbandingan
      new Date(),
    ]);

    if (values.length > 0) {
      await connection.query(insertQuery, [values]);
    }

    await connection.commit();
    res
      .status(200)
      .json({ success: true, message: "Data opname berhasil diupload." });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error uploadHasilOpname:", error);
    res
      .status(500)
      .json({ success: false, message: "Gagal mengupload data opname." });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { downloadMasterBarang, uploadHasilOpname };
