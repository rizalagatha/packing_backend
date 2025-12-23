const express = require("express");
const router = express.Router();
const controller = require("../controllers/authorization.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// Middleware Token wajib untuk semua route di bawah ini
router.use(authenticateToken);

// GET /api/authorization/pending -> List request status 0
router.get("/pending", controller.getPendingRequests);

// POST /api/authorization/process -> Action Approve/Reject
router.post("/process", controller.processRequest);

module.exports = router;
