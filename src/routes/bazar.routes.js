const express = require("express");
const router = express.Router();
const bazarController = require("../controllers/bazar.controller");
const auth = require("../middleware/auth.middleware"); // Pastikan path-nya benar

// Endpoint untuk download master barang khusus bazar (dengan harga)
router.get("/download-master", auth, bazarController.downloadMasterBazar);

module.exports = router;
