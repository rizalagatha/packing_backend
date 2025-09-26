const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (token == null) {
    return res.status(401).json({ 
      success: false, 
      message: 'Akses ditolak. Token tidak ditemukan.' 
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        message: 'Token tidak valid atau sudah kedaluwarsa.' 
      });
    }
    req.user = user; // Menyimpan data user dari token ke object request
    next(); // Lanjutkan ke controller selanjutnya
  });
};

module.exports = {
  authenticateToken,
};