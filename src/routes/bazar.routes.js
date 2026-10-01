const express = require("express");
const router = express.Router();
const bazarController = require("../controllers/bazar.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// Endpoint untuk download master barang khusus bazar (dengan harga)
router.get(
  "/download-master",
  authenticateToken,
  bazarController.downloadMasterBazar,
);
router.post(
  "/upload-koreksi",
  authenticateToken,
  bazarController.uploadKoreksiBazar,
);
router.post(
  "/upload-sales",
  authenticateToken,
  bazarController.uploadBazarSales,
);
router.post(
  "/create-customer",
  authenticateToken,
  bazarController.createBazarCustomer,
);
router.get("/catalog", authenticateToken, bazarController.searchBazarCatalog);
router.get(
  "/product/:barcode",
  authenticateToken,
  bazarController.getBazarProduct,
);
router.get(
  "/filters",
  authenticateToken,
  bazarController.getBazarFilterOptions,
);
router.get(
  "/customers",
  authenticateToken,
  bazarController.searchBazarCustomers,
);
router.get(
  "/default-customer",
  authenticateToken,
  bazarController.getBazarDefaultCustomer,
);
router.get("/history", authenticateToken, bazarController.getBazarSalesHistory);
router.get(
  "/history/:nomor",
  authenticateToken,
  bazarController.getBazarSaleDetail,
);
router.get(
  "/koreksi/history",
  authenticateToken,
  bazarController.getBazarKoreksiHistory,
);
router.post("/checkout", authenticateToken, bazarController.checkoutBazar);
router.get("/rekening", authenticateToken, bazarController.getBazarRekening);
router.get(
  "/images/:kode",
  authenticateToken,
  bazarController.getBazarProductImages,
);
router.post(
  "/promo-discounts",
  authenticateToken,
  bazarController.getBazarPromoDiscounts,
);
router.post(
  "/tukar-barang",
  authenticateToken,
  bazarController.tukarBarangBazar,
);

module.exports = router;
