const express = require("express");
const router = express.Router();
const penjualanController = require("../controllers/penjualan.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);
router.get("/rekening", penjualanController.searchRekening);
router.get("/promos", penjualanController.getActivePromos);
router.get("/default-customer", penjualanController.getDefaultCustomer);
router.get("/scan/:barcode", penjualanController.findProductByBarcode);
router.post("/save", penjualanController.savePenjualan);

router.get("/print/:nomor", penjualanController.getPrintData);
router.post("/send-wa", penjualanController.sendReceiptWa);
router.post("/send-wa-image", protect, penjualanController.sendReceiptWaImage);

module.exports = router;
