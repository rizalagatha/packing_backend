const express = require('express');
const router = express.Router();
const sjController = require('../controllers/suratJalan.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.use(authenticateToken);

// --- URUTAN DIPERBAIKI DI SINI ---

// Rute-rute spesifik harus didefinisikan terlebih dahulu
router.get('/history', sjController.getSuratJalanHistory);
router.get('/load-items', sjController.getItemsForLoad);
router.get('/load-from-packing/:packNomor', sjController.getItemsFromPacking);
router.get('/search/stores', sjController.searchStores);
router.get('/search/permintaan', sjController.searchPermintaan);
router.get('/search/terima-rb', sjController.searchTerimaRb);

// Baru setelah itu rute dinamis/umum
router.get('/:nomor', sjController.loadForEdit); // Muat data SJ untuk diubah
router.post('/', sjController.saveData); // Simpan SJ baru atau perubahan

module.exports = router;