const express = require("express");
const router = express.Router();
const controller = require("../controllers/authorization.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// Middleware Token wajib untuk semua route di bawah ini
router.use(authenticateToken);

// Endpoint untuk HP yang meminta otorisasi
router.post("/request", controller.createRequest);
router.get("/status/:authNomor", controller.checkStatus);

// Endpoint untuk Manager/Store yang meng-approve
router.get("/pending", controller.getPendingRequests);
router.post("/process", controller.processRequest);

module.exports = router;
