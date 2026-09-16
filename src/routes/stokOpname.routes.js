const express = require("express");
const router = express.Router();
const soController = require("../controllers/stokOpname.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);
router.get("/cabang", soController.getCabangList);
router.get("/download", soController.downloadMasterBarang);
router.get("/download-lokasi", soController.downloadMasterLokasi);
router.get("/download-unit", soController.downloadMasterUnit);
router.get("/missing-units", soController.getMissingUnits);
router.post("/upload", soController.uploadHasilOpname);
router.get("/compare-lokasi", soController.checkMismatchLokasi);

module.exports = router;
