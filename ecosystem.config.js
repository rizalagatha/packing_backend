require("dotenv").config(); // Panggil dotenv di sini

module.exports = {
  apps: [
    {
      // --- APLIKASI PRODUKSI (RESMI) ---
      name: "packing-prod",
      script: "index.js",
      watch: true,
      ignore_watch: [
        "node_modules",
        ".wwebjs_auth",
        ".wwebjs_cache",
        "public",
        "logs",
      ],
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_DATABASE: process.env.DB_NAME_PROD, // Pakai DB Prod
        DB_PORT: process.env.DB_PORT,
        JWT_SECRET: process.env.JWT_SECRET,
      },
    },
    {
      // --- APLIKASI TRIAL ---
      name: "packing-trial",
      script: "index.js",
      watch: true,
      ignore_watch: [
        "node_modules",
        ".wwebjs_auth",
        ".wwebjs_cache",
        "public",
        "logs",
      ],
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3002,
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_DATABASE: process.env.DB_NAME_TRIAL, // Pakai DB Trial
        DB_PORT: process.env.DB_PORT,
        JWT_SECRET: process.env.JWT_SECRET,
      },
    },
    {
      // --- APLIKASI LOKAL (UNTUK TESTING DEV) ---
      name: "packing-local",
      script: "index.js",
      watch: true,
      ignore_watch: [
        "node_modules",
        ".wwebjs_auth",
        ".wwebjs_cache",
        "public",
        "logs",
      ],
      env: {
        NODE_ENV: "development",
        PORT: 3004,
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_PASSWORD: process.env.DB_PASSWORD,
        DB_DATABASE: process.env.DB_NAME_TRIAL, // Pakai DB Trial
        DB_PORT: process.env.DB_PORT,
        JWT_SECRET: process.env.JWT_SECRET,
      },
    },
  ],
};
