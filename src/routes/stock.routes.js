const express = require('express');
const router = express.Router();
const stockController = require('../controllers/stock.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

// Endpoint analisis stok menipis
router.get('/low-stock', stockController.getLowStock);

module.exports = router;