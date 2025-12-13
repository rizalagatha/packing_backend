const express = require("express");
const router = express.Router();
const soController = require("../controllers/stokOpname.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);
router.get("/download", soController.downloadMasterBarang);
router.post("/upload", soController.uploadHasilOpname);

module.exports = router;
