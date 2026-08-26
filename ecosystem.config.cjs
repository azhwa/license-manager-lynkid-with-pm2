module.exports = {
  apps: [{
    name: 'license-manager-api',
    cwd: __dirname,
    script: 'node_modules/tsx/dist/cli.mjs',
    args: 'src/node/server.ts',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 3000,
    max_memory_restart: '350M',
    kill_timeout: 5000,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3000',
    },
  }],
};
