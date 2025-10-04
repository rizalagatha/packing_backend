const express = require('express');
const router = express.Router();
const sjController = require('../controllers/suratJalan.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

// Menerapkan middleware otentikasi untuk semua rute di bawah ini
router.use(authenticateToken);

// Rute utama untuk menyimpan data
router.post('/', sjController.saveData);

router.get('/:nomor', sjController.loadForEdit);

// Rute untuk mengambil item dari nomor referensi
router.get('/load-items', sjController.getItemsForLoad);
router.get('/load-from-packing/:packNomor', sjController.getItemsFromPacking);

// Rute-rute pencarian
router.get('/search/stores', sjController.searchStores);
router.get('/search/permintaan', sjController.searchPermintaan);
router.get('/search/terima-rb', sjController.searchTerimaRb);

router.get('/history', sjController.getSuratJalanHistory);

module.exports = router;