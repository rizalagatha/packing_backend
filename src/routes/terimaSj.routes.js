const express = require("express");
const router = express.Router();
const terimaSjController = require("../controllers/terimaSj.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// Terapkan middleware untuk semua rute di bawah ini
router.use(authenticateToken);

// Rute untuk mencari SJ yang akan diterima
router.get("/search-sj", terimaSjController.searchSj);

// Rute untuk memuat data dari SJ terpilih
router.get("/load-sj/:nomorSj", terimaSjController.loadInitialData);

// Rute untuk menyimpan data penerimaan
router.post("/", terimaSjController.saveData);

module.exports = router;
