module.exports = {
  apps: [
    {
      // --- APLIKASI PRODUKSI (RESMI) ---
      name: "packing-prod",
      script: "index.js",
      env: {
        "NODE_ENV": "production",
        "PORT": 3000,
        "DB_HOST": "localhost",
        "DB_USER": "root",
        "DB_PASSWORD": "Kencana#123",
        "DB_NAME": "retail",
        "DB_PORT": 3307
      }
    },
    {
      // --- APLIKASI TRIAL ---
      name: "packing-trial",
      script: "index.js",
      env: {
        "NODE_ENV": "production", // Tetap production agar efisien
        "PORT": 3002, // PORT BERBEDA
        "DB_HOST": "localhost",
        "DB_USER": "root",
        "DB_PASSWORD": "Kencana#123",
        "DB_NAME": "retailnew", // DATABASE BERBEDA
        "DB_PORT": 3307
      }
    }
  ]
};