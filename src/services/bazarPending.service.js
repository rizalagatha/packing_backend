// Penjualan bazar di tinv_hdr_tmp yang belum diklerek di web.
// Stok di tmasterstok baru berkurang saat klerek, jadi selama menunggu
// jumlah ini dikurangkan di layar bazar. Placeholder: pola nomor nota ("B02-%").
// invd_kode di tabel tmp berisi BARCODE, dipetakan ke kode barang + ukuran.
const PENDING_SALES_SQL = `
  SELECT b.brgd_kode AS kode, b.brgd_ukuran AS ukuran, SUM(d.invd_jumlah) AS qty
  FROM tinv_hdr_tmp h
  JOIN tinv_dtl_tmp d ON d.invd_inv_nomor = h.inv_nomor
  JOIN tbarangdc_dtl b ON TRIM(b.brgd_barcode) = d.invd_kode
  WHERE h.inv_nomor LIKE ?
  GROUP BY b.brgd_kode, b.brgd_ukuran
`;

module.exports = { PENDING_SALES_SQL };
