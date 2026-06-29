const express = require("express");
const router = express.Router();
const mobileSoController = require("../controllers/mobileSo.controller.js");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// Mendapatkan berkas daftar Surat Pesanan (Browse)
router.get("/", mobileSoController.getList);

// Mendapatkan daftar item pakaian di dalam SO (Detail)
router.get("/details/:nomor", mobileSoController.getDetails);

// Menjalankan auto mutasi waktu pemindaian fisik item
router.post("/auto-mutasi-scan", mobileSoController.autoMutasiScan);

module.exports = router;
