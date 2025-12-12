const express = require("express");
const router = express.Router();
const penjualanController = require("../controllers/penjualan.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);
router.get("/default-customer", penjualanController.getDefaultCustomer);
router.get("/scan/:barcode", penjualanController.findProductByBarcode);
router.post("/save", penjualanController.savePenjualan);

module.exports = router;
