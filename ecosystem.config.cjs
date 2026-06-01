// PM2 process manager config — for direct VPS deployment without Docker.
// Usage: pm2 start ecosystem.config.cjs --only paper
//        pm2 start ecosystem.config.cjs --only live
module.exports = {
  apps: [
    {
      name: "paper",
      script: "dist/sim/runPaper.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      max_memory_restart: "300M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/paper-error.log",
      out_file: "logs/paper-out.log",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "live",
      script: "dist/sim/runLive.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 5,
      min_uptime: 60000,
      max_memory_restart: "300M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/live-error.log",
      out_file: "logs/live-out.log",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
