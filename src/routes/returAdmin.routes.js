const express = require("express");
const router = express.Router();
const returController = require("../controllers/returAdmin.controller.js");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

router.get("/search-penerimaan", returController.searchPenerimaanSj);
router.get("/load-selisih/:tjNomor", returController.loadSelisihData);
router.post("/", returController.saveRetur);

module.exports = router;
