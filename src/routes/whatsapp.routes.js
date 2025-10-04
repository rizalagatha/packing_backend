const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsapp.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.use(authenticateToken);

// Endpoint untuk meminta QR code
router.get('/qr', whatsappController.getQrCode);

// Endpoint untuk menghapus sesi
router.delete('/session', whatsappController.logout);

module.exports = router;