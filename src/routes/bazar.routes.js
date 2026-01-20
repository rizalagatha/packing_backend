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

module.exports = router;
