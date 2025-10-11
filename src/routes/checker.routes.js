const express = require('express');
const router = express.Router();
const checkerController = require('../controllers/checker.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.use(authenticateToken);

router.get('/search-stbj', authenticateToken, checkerController.searchStbj);
router.get('/load-stbj/:stbjNomor', authenticateToken, checkerController.loadStbjData);
router.post('/on-check', checkerController.onCheck);

module.exports = router;