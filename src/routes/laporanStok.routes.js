const express = require("express");
const router = express.Router();
const laporanStokController = require("../controllers/laporanStok.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// Laporan Stok Keseluruhan (Real-Time)
router.get("/real-time", laporanStokController.getRealTimeStock);

// Laporan Stok Menipis (Low Stock)
router.get("/low-stock", laporanStokController.getLowStock);

module.exports = router;
