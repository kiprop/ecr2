const path = require('path');

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const basePath = (env.BASE_PATH || '').replace(/\/+$/, '');

module.exports = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT || 3000),
  basePath,
  appBaseUrl: (env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret',
  appName: 'ECR 2.0',
  db: {
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER || 'ecr',
    password: env.DB_PASSWORD || 'ecr',
    database: env.DB_NAME || 'ecr',
  },
  auth: {
    mode: env.AUTH_MODE === 'mock' ? 'mock' : 'entra',
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    clientSecret: env.ENTRA_CLIENT_SECRET,
    superAdmins: list(env.SUPER_ADMINS).map((e) => e.toLowerCase()),
  },
  storageDir: path.resolve(env.STORAGE_DIR || './data/blobs'),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 25),
  mail: {
    sender: env.MAIL_SENDER || '',          // mailbox Graph sends as; blank = log only
  },
  directorySearch: env.DIRECTORY_SEARCH === 'true', // needs Graph User.Read.All (application)
  workerIntervalMin: Number(env.WORKER_INTERVAL_MIN || 60),
};
