const express = require("express");
const router = express.Router();
const stockController = require("../controllers/stock.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// Endpoint analisis stok menipis
router.get("/low-stock", stockController.getLowStock);

router.post("/create-auto", stockController.createPermintaanOtomatis);

module.exports = router;
