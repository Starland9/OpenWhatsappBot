module.exports = {
  apps: [{
    name: 'open-whatsapp-bot',
    script: 'index.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    node_args: '--max-old-space-size=512 --expose-gc',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    // CPU and memory optimization
    kill_timeout: 5000,
    listen_timeout: 3000,
    // Log rotation to prevent disk space issues
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
}
