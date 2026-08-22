const pool = require("../config/database");

/**
 * @description Tanggal closing otomatis bulan berjalan (dipakai untuk cek "hari ini").
 * Direplikasi persis dari logika MANKSI getTanggalTutupBuku.
 */
const getTanggalTutupBuku = async () => {
  try {
    const query = `SELECT tgl_close FROM kencanaprint.tversi WHERE aplikasi = "MANKSI" LIMIT 1`;
    const [rows] = await pool.query(query);
    let ztglclose = 0;
    if (rows.length > 0) {
      ztglclose = parseInt(rows[0].tgl_close, 10);
    }
    const today = new Date();
    let zDay = today.getDate();
    let zMonth = today.getMonth() + 1;
    let zYear = today.getFullYear();
    if (zDay <= ztglclose) {
      if (zMonth === 1) {
        zMonth = 12;
        zYear = zYear - 1;
      } else {
        zMonth = zMonth - 1;
      }
    }
    return new Date(zYear, zMonth - 1, 1);
  } catch (error) {
    console.error("Gagal menghitung tanggal tutup buku (zdtClose):", error);
    return new Date(2000, 0, 1);
  }
};

/**
 * @description Boundary closing OTOMATIS untuk BULAN TRANSAKSI TERTENTU
 * (bukan cuma hari ini) — dipakai untuk cek "apakah tanggal transaksi record
 * ini sudah lewat masa closing-nya".
 */
const getTanggalTutupBukuUntukTanggal = async (tanggalRecord) => {
  try {
    const query = `SELECT tgl_close FROM kencanaprint.tversi WHERE aplikasi = "MANKSI" LIMIT 1`;
    const [rows] = await pool.query(query);

    let ztglclose = 0;
    if (rows.length > 0) {
      ztglclose = parseInt(rows[0].tgl_close, 10);
    }

    const ref = new Date(tanggalRecord);
    const zDay = ztglclose;
    let zMonth = ref.getMonth() + 1;
    let zYear = ref.getFullYear();

    if (zMonth === 12) {
      zMonth = 1;
      zYear = zYear + 1;
    } else {
      zMonth = zMonth + 1;
    }

    return new Date(zYear, zMonth - 1, zDay);
  } catch (error) {
    console.error("Gagal menghitung batas close per tanggal record:", error);
    return new Date(2000, 0, 1);
  }
};

/**
 * @description Tanggal tutup buku MANUAL per modul (override closing otomatis).
 * @param {string} modulNama Nilai cid di pengaturan.tclose, mis. 'PERMINTAAN GARMEN'
 */
const getManualTutupBuku = async (modulNama) => {
  try {
    const query = `
      SELECT ctgl 
      FROM pengaturan.tclose 
      WHERE cprogram = "MANKSI" AND cid = ? 
      LIMIT 1
    `;
    const [rows] = await pool.query(query, [modulNama]);

    if (rows.length > 0 && rows[0].ctgl) {
      return new Date(rows[0].ctgl);
    }
    return null;
  } catch (error) {
    console.error(
      `Gagal mengambil manual tutup buku untuk ${modulNama}:`,
      error,
    );
    return null;
  }
};

module.exports = {
  getTanggalTutupBuku,
  getManualTutupBukuUntukTanggal: getTanggalTutupBukuUntukTanggal,
  getManualTutupBuku,
};
