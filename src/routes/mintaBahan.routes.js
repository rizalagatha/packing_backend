const express = require("express");
const router = express.Router();
const controller = require("../controllers/mintaBahan.controller.js");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// Browse - daftar permintaan
router.get("/", controller.getAll);

// Detail (expand row)
router.get("/:nomor/details", controller.getDetails);

// Badge notifikasi realisasi belum di-approve
router.get("/check-unapproved", controller.checkUnapproved);

// PUT /api/minta-bahan/realisasi/:noRealisasi/approve
router.put("/realisasi/:noRealisasi/approve", controller.approveRealisasi);

module.exports = router;
