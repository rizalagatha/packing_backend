const express = require('express');
const router = express.Router();
const produkController = require('../controllers/produk.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

/**
 * @route   GET /api/produk/:barcode
 * @desc    Mencari dan memvalidasi produk berdasarkan barcode
 * @access  Private (butuh token)
 */
router.get('/:barcode', authenticateToken, produkController.findByBarcode);

module.exports = router;