const express = require('express');
const router = express.Router();
const packingController = require('../controllers/packing.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

/**
 * @route   POST /api/packing
 * @desc    Membuat sesi packing baru
 * @access  Private (butuh token)
 */
router.post('/', authenticateToken, packingController.createPacking);

router.get('/history', authenticateToken, packingController.getPackingHistory);

router.get('/search', authenticateToken, packingController.searchPacking);

router.delete('/:nomor', authenticateToken, packingController.deletePacking);

router.get('/:nomor', authenticateToken, packingController.getPackingDetail);

// Anda bisa menambahkan rute lain terkait packing di sini nanti
// Contoh: router.get('/', authenticateToken, packingController.getAllPacking);

module.exports = router;