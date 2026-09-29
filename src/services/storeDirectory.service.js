const pool = require("../config/database");

const STATIC_HEADER =
  "Terimakasih atas kunjungan anda.\n\nKaosan - Vendor Clothing Line\n\n";

const STATIC_FOOTER =
  "Facebook: facebook.com/kaosanofficial\n" +
  "Instagram: instagram.com/kaosan.official\n" +
  "Shopee: shopee.co.id/kaosan_official\n" +
  "Tokopedia: tokopedia.link/2wGzPptH7Ob\n" +
  "TikTok: tiktok.com/@kaosanofficial";

let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit, tgudang jarang berubah

const stripTelpPrefix = (telp) =>
  (telp || "").replace(/^(wa|WA)\s*:\s*/i, "").trim();

const buildStoreDirectoryText = (rows) => {
  const groups = [];
  for (const r of rows) {
    const kota = (r.gdg_inv_kota || "").trim();
    const last = groups[groups.length - 1];
    if (last && last.kota === kota && kota !== "") {
      last.rows.push(r);
    } else {
      groups.push({ kota, rows: [r] });
    }
  }

  const blocks = groups.map((g) => {
    const lines = g.rows.map(
      (r) =>
        `${(r.gdg_inv_nama || "").trim()} (${stripTelpPrefix(r.gdg_inv_telp)})`,
    );
    const alamatDasar = (g.rows[0].gdg_inv_alamat || "").trim();
    const alamat = g.kota ? `${alamatDasar}, ${g.kota}` : alamatDasar;

    // Label khusus (kalau ada baris di grup ini yang punya gdg_label_struk)
    // menang atas nama kota; kalau tidak ada, judulnya nama kota seperti biasa.
    const labelKhusus = g.rows
      .map((r) => (r.gdg_label_struk || "").trim())
      .find((l) => l !== "");
    const judul = labelKhusus || g.kota;
    const header = judul ? `Store ${judul}\n` : "";

    return `${header}${lines.join("\n")}\n\n${alamat}`;
  });

  return `${STATIC_HEADER}${blocks.join("\n\n\n")}\n\n\n${STATIC_FOOTER}`;
};

const getStoreDirectoryText = async () => {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) {
    return cache;
  }
  const [rows] = await pool.query(
    `SELECT gdg_kode, gdg_inv_nama, gdg_inv_telp, gdg_inv_alamat, gdg_inv_kota, gdg_label_struk
     FROM tgudang
     WHERE (gdg_inv_alamat <> '' OR gdg_inv_telp <> '')
       AND (gdg_dc = 0 OR gdg_kode = 'SL1')
     ORDER BY gdg_inv_kota = '' DESC, gdg_kode ASC`,
  );
  cache = buildStoreDirectoryText(rows);
  cacheAt = now;
  return cache;
};

const invalidateStoreDirectoryCache = () => {
  cache = null;
};

module.exports = {
  getStoreDirectoryText,
  invalidateStoreDirectoryCache,
  buildStoreDirectoryText, // diekspor untuk verifikasi manual
};
