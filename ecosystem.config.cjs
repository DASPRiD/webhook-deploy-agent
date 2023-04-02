module.exports = {
    apps: [{
        name: 'webhook-deploy-agent',
        script: `${process.env.PWD}/current/index.js`,
        cwd: `${process.env.PWD}/current/`,
        watch: false,
        autorestart: true,
        wait_ready: true,
        restart_delay: 1000,
        kill_timeout: 3000,
        exec_mode: 'cluster',
        instances: 1,
        instance_var: 'INSTANCE_ID',
        time: true,
        env: {
            NODE_ENV: 'production',
            APP_ROOT_PATH: `${process.env.PWD}/current/`,
            NODE_CONFIG_DIR: `${process.env.PWD}/current/config/`,
            PORT: process.env.PORT,
            HOST: process.env.HOST,
        },
    }],
};
