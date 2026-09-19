const express = require("express");
const router = express.Router();
const controller = require("../controllers/bukuTamu.controller.js");
const { authenticateToken } = require("../middlewares/auth.middleware");

router.use(authenticateToken);

// Sesi (Header)
router.get("/sesi", controller.getSesiList);
router.post("/sesi/save", controller.saveSesi);
router.put("/sesi/:nomor/close", controller.closeSesi);
router.get("/sesi/:nomor", controller.getSesiDetail);

// Tamu (Detail)
router.post("/sesi/:nomor/tamu", controller.addTamu);
router.put("/tamu/:idrec", controller.updateTamu);
router.put("/tamu/:idrec/toggle-potential", controller.togglePotential);
router.delete("/tamu/:idrec", controller.deleteTamu);

module.exports = router;
