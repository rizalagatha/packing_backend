const express = require('express');
const router = express.Router();
const spkController = require('../controllers/spk.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.get('/by-barcode/:barcode', authenticateToken, spkController.findSpkByBarcode);

module.exports = router;