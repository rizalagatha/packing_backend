const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// Rute untuk login pengguna
// Method: POST, URL: /api/auth/login
router.post('/login', authController.login);

// (Anda bisa menambahkan rute otentikasi lain di sini, misal: register, logout, dll)
router.post('/select-branch', authController.selectBranch);

router.put("/fcm-token", verifyToken, authController.updateFcmToken);

module.exports = router;