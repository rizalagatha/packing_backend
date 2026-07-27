const express = require("express");
const router = express.Router();
const controller = require("../controllers/mintaBahanForm.controller.js");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// Lookup barang (F1 search) — untuk SearchModal di form
router.get("/search-barang", controller.searchBarang);

// Load data untuk mode Edit
router.get("/:nomor", controller.getForEdit);

// Simpan (Create / Update)
router.post("/save", controller.save);

module.exports = router;
