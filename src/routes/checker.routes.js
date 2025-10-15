// File: checker.routes.js
const express = require('express');
const router = express.Router();
const checkerController = require('../controllers/checker.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.use(authenticateToken);

router.get('/search-stbj', checkerController.searchStbj);
router.get('/load-stbj/:stbjNomor', checkerController.loadStbjData);
router.get('/packing-detail/:nomor', checkerController.getPackingDetailForChecker); // ✅ Ubah ini
router.post('/on-check', checkerController.onCheck);

module.exports = router;