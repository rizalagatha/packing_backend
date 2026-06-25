const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { authenticateToken } = require("../middlewares/auth.middleware");

// [FIX] JANGAN pasang authenticateToken secara global di sini!
// router.use(authenticateToken); <--- INI PENYEBABNYA

// --- RUTE PUBLIK (Tidak butuh token) ---

// Rute untuk login pengguna
router.post("/login", authController.login);

// --- RUTE DEVICE BINDING (MOBILE KEYSTORE) ---
router.post("/enroll-device", authController.enrollDevice); // Pendaftaran perangkat baru
router.post("/request-challenge", authController.requestChallenge); // Minta string acak untuk ditandatangani
router.post("/login-device", authController.loginWithDevice); // Login menggunakan Signature Keystore

// Rute pilih cabang (ini pakai preAuthToken di body, jadi tidak butuh header Bearer standar)
router.post("/select-branch", authController.selectBranch);

// --- RUTE PRIVAT (Butuh Token) ---

// [FIX] Pasang middleware hanya di rute yang butuh login
router.put("/fcm-token", authenticateToken, authController.updateFcmToken);

router.post("/logout", authenticateToken, authController.logout);

module.exports = router;
