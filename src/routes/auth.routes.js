const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

// Rute untuk login pengguna
// Method: POST, URL: /api/auth/login
router.post('/login', authController.login);

// (Anda bisa menambahkan rute otentikasi lain di sini, misal: register, logout, dll)

module.exports = router;