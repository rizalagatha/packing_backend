const express = require("express");
const router = express.Router();
const controller = require("../controllers/terimaReturDc.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// --- URUTAN MINIMALIS (Tanpa Pending) ---

// 1. Pencarian tetap ada
router.get("/search", controller.searchRetur);

// 2. Load detail retur berdasarkan nomor
router.get("/:nomorRb", controller.loadDetail);

// 3. Simpan final (Langsung tembak ke sini)
router.post("/", controller.saveTerima);

module.exports = router;
