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
        DB_HOST: "103.94.238.252",
        DB_USER: "root",
        DB_PASSWORD: "Kencana#123",
        DB_DATABASE: "retail",
        DB_PORT: 3306,
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
        DB_HOST: "103.94.238.252",
        DB_USER: "root",
        DB_PASSWORD: "Kencana#123",
        DB_DATABASE: "retailnew", // DATABASE BERBEDA
        DB_PORT: 3306,
        JWT_SECRET: "s+qG0PB3JQB/jHABdHfVejMBUm9zJtE4Mb1GHMAYXsw=",
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
        PORT: 3004, // Gunakan port berbeda khusus lokal
        DB_HOST: "103.94.238.252", // Tetap tembak DB Server (atau 127.0.0.1 jika DB ada di laptop)
        DB_USER: "root", // Isi sesuai kredensial Anda
        DB_PASSWORD: "Kencana#123",
        DB_DATABASE: "retailnew", // Gunakan DB Trial agar aman untuk testing-testing
        DB_PORT: 3306,
        JWT_SECRET: "s+qG0PB3JQB/jHABdHfVejMBUm9zJtE4Mb1GHMAYXsw=",
      },
    },
  ],
};
