const express = require('express');
const router = express.Router();
const mintaController = require('../controllers/mintaBarang.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.use(authenticateToken);

router.get('/auto-buffer', mintaController.getBufferStokItems);
router.get('/scan/:barcode', mintaController.findByBarcode);
router.post('/', mintaController.save);

module.exports = router;