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
        DB_HOST: "localhost",
        DB_USER: "root",
        DB_PASSWORD: "Kencana#123",
        DB_DATABASE: "retail",
        DB_PORT: 3307,
        JWT_SECRET: "s+qG0PB3JQB/jHABdHfVejMBUm9zJtE4Mb1GHMAYXsw=",
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
        NODE_ENV: "production", // Tetap production agar efisien
        PORT: 3002, // PORT BERBEDA
        DB_HOST: "localhost",
        DB_USER: "root",
        DB_PASSWORD: "Kencana#123",
        DB_DATABASE: "retailnew", // DATABASE BERBEDA
        DB_PORT: 3307,
        JWT_SECRET: "s+qG0PB3JQB/jHABdHfVejMBUm9zJtE4Mb1GHMAYXsw=",
      },
    },
  ],
};
