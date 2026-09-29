// src/routes/app.routes.js
const express = require("express");
const router = express.Router();
const appController = require("../controllers/app.controller.js");

// Rute untuk cek versi aplikasi
router.get("/version", appController.getAppVersion);

router.get(
  "/store-directory",
  authenticateToken,
  appController.getStoreDirectory,
);

module.exports = router;
