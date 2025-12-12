const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/invoice.controller"); // Pastikan path sesuai
const { authenticateToken } = require("../middleware/auth.middleware");

router.use(authenticateToken);

// Mengambil list invoice (Browse)
router.get("/", invoiceController.getList);

// Mengambil detail invoice (untuk modal detail di HP)
router.get("/details/:nomor", invoiceController.getDetails);

// Lookup cabang (untuk filter)
router.get("/lookup/cabang", invoiceController.getCabangList);

module.exports = router;
