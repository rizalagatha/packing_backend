const express = require('express');
const router = express.Router();
const mutasiController = require("../controllers/mutasiStore.controller")
const { authenticateToken } = require('../middlewares/auth.middleware');

router.use(authenticateToken);

// Rute untuk menyimpan data mutasi
router.post('/', mutasiController.save);

// Rute untuk mencari store tujuan
router.get('/lookup-tujuan', mutasiController.lookupTujuanStore);

module.exports = router;