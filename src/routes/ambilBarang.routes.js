const express = require("express");
const router = express.Router();
const ambilBarangController = require("../controllers/ambilBarang.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

router.get(
  "/lookup/product-by-barcode",
  ambilBarangController.lookupProductByBarcode
);
router.post("/", ambilBarangController.saveData);

module.exports = router;
