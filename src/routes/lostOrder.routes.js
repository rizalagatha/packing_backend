const express = require("express");
const router = express.Router();
const lostOrderController = require("../controllers/lostOrder.controller");
const authMiddleware = require("../middlewares/auth.middleware");

// Terapkan middleware auth agar hanya user ter-login yang bisa akses
router.use(authMiddleware);

// Endpoint POST untuk menyimpan data
router.post("/", lostOrderController.createLostOrder);

// Endpoint GET untuk melihat riwayat
router.get("/", lostOrderController.getLostOrders);

module.exports = router;
