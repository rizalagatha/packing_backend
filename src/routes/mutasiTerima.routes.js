const express = require('express');
const router = express.Router();
const mutasiTerimaController = require('../controllers/mutasiTerima.controller.js');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.use(authenticateToken);

// Rute untuk mencari dokumen Mutasi Kirim yang belum diterima
router.get('/search-kirim', mutasiTerimaController.searchKirim);

// Rute untuk memuat detail dari dokumen Kirim yang dipilih
router.get('/load-kirim/:nomorKirim', mutasiTerimaController.loadFromKirim);

// Rute untuk menyimpan data penerimaan mutasi
router.post('/', mutasiTerimaController.save);

module.exports = router;