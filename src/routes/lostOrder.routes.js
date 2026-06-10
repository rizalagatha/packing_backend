const express = require("express");
const router = express.Router();
const lostOrderController = require("../controllers/lostOrder.controller");

// [PERBAIKAN DI SINI]
// Sesuaikan "verifyToken" dengan nama fungsi asli yang ada di file auth.middleware.js Anda
const { authenticateToken } = require("../middlewares/auth.middleware");

// Terapkan middleware
router.use(authenticateToken);

// Endpoint POST untuk menyimpan data
router.post("/", lostOrderController.createLostOrder);

// Endpoint GET untuk melihat riwayat
router.get("/", lostOrderController.getLostOrders);

module.exports = router;
