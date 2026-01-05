const express = require("express");
const router = express.Router();
const packingListController = require("../controllers/packingList.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// Middleware: Wajib Login
router.use(authenticateToken);

// 1. Simpan (Create / Update)
router.post("/save", packingListController.savePackingList);

// 2. Get Detail (Untuk Edit)
router.get("/form/:nomor", packingListController.getPackingListDetail);

// 3. Load Item dari Permintaan
router.get("/load-request", packingListController.loadItemsFromRequest);

// 4. Cari Barang via Barcode
router.get("/barcode/:barcode", packingListController.findProductByBarcode);

// 5. Lookup Permintaan (Modal Search)
router.get("/search-permintaan", packingListController.searchPermintaanOpen);

// Ambil Daftar Riwayat Packing List (Filter Tanggal)
router.get('/history/list', verifyToken, controller.getHistory);

// Ambil Detail Item Riwayat (untuk Accordion/Expand)
router.get('/history/:nomor/detail', verifyToken, controller.getHistoryDetail);

module.exports = router;
