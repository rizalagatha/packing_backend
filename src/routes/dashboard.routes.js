const express = require("express");
const router = express.Router();
const dashboardController = require("../controllers/dashboard.controller");
const { authenticateToken } = require("../middlewares/auth.middleware"); // Sesuaikan path middleware auth Anda

// Semua route dashboard butuh login
router.use(authenticateToken);

// 1. Stats Hari Ini
router.get("/today-stats", dashboardController.getTodayStats);

// 2. Total Piutang
router.get("/total-sisa-piutang", dashboardController.getTotalPiutang);

// 3. Ranking Cabang (Management Only)
router.get("/branch-performance", dashboardController.getBranchPerformance);

// 4. Grafik Penjualan
router.get("/sales-chart", dashboardController.getSalesChart);

// 5. Pending Actions (Notifikasi)
router.get("/pending-actions", dashboardController.getPendingActions);

// --- 6. TARGET PENJUALAN (BARU) ---
router.get("/sales-target-summary", dashboardController.getSalesTargetSummary);

// 7. List Total Piutang Per Cabang
router.get("/piutang-per-cabang", dashboardController.getPiutangPerCabang);

// 8. Detail Invoice Piutang Per Cabang
router.get(
  "/piutang-detail/:cabang",
  dashboardController.getBranchPiutangDetail
);

router.get("/top-selling", dashboardController.getTopSellingProducts);

router.get("/stock-spread/:barcode", dashboardController.getProductStockSpread);

module.exports = router;
