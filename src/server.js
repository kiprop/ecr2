const path = require('path');
const crypto = require('crypto');
const express = require('express');
require('express-async-errors');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const db = require('./db');
const domain = require('./domain');
const auth = require('./auth');

if (config.isProd && config.auth.mode === 'mock') { console.error('[ecr2] AUTH_MODE=mock is not allowed in production'); process.exit(1); }
if (config.isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) { console.error('[ecr2] SESSION_SECRET must be set (32+ chars)'); process.exit(1); }

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], formAction: ["'self'", 'https://login.microsoftonline.com'],
      frameAncestors: ["'none'"], upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(morgan(config.isProd ? 'combined' : 'dev', { skip: (req) => req.url.includes('/public/') || req.url.endsWith('/healthz') }));

const bp = config.basePath;
app.use((req, res, next) => { Object.assign(res.locals, { bp, user: null, scope: [], csrf: '', flash: '', d: domain, authMode: config.auth.mode, drawer: null }); next(); });

// Subpath support: every root-relative redirect gets BASE_PATH, so routes can redirect('/x').
app.use((req, res, next) => {
  res.locals.bp = bp;
  const original = res.redirect.bind(res);
  res.redirect = (...args) => {
    const i = args.length - 1; const url = args[i];
    if (bp && typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && url !== bp && !url.startsWith(bp + '/')) args[i] = bp + url;
    return original(...args);
  };
  next();
});

app.use(bp + '/public', express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '1d' : 0 }));
app.get(bp + '/healthz', async (req, res) => {
  try { await db.q('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
});

app.use(session({
  store: new PgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true }),
  name: 'ecr2.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: bp || '/', maxAge: 1000 * 60 * 60 * 8 },
}));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Current user, scope, CSRF token, flash, view helpers
app.use(async (req, res, next) => {
  try {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.flash = req.session.flash || ''; delete req.session.flash;
    res.locals.d = domain;
    res.locals.authMode = config.auth.mode;
    res.locals.user = null;
    if (req.session.userId) {
      const u = await db.one(`SELECT * FROM users WHERE id=$1`, [req.session.userId]);
      if (u && u.status === 'active') {
        req.user = u;
        req.scope = await domain.loadScope(u);
        res.locals.user = u;
        res.locals.scope = req.scope;
        if (domain.canReview(u)) res.locals.reviewBadge = (await db.one(`SELECT count(*)::int n FROM obligations WHERE status='submitted' AND country_code = ANY($1)`, [req.scope])).n;
      } else { req.session.userId = null; }
    }
    req.flash = (m) => { req.session.flash = m; };
    next();
  } catch (e) { next(e); }
});

// CSRF on every form post (multipart routes check after parsing; see csrfCheck)
function csrfCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const t = req.body && req.body._csrf;
  if (!t || t !== req.session.csrf) return res.status(403).render('error', { title: 'Session expired', message: 'Your session expired or the form was out of date. Go back, reload the page and try again.' });
  next();
}

const router = express.Router();
router.use((req, res, next) => (req.is('multipart/form-data') ? next() : csrfCheck(req, res, next)));
router.use(auth.router);
router.use((req, res, next) => {
  if (req.user) return next();
  if (req.method === 'GET' && !req.path.startsWith('/cal/')) return res.redirect('/login' + (req.path !== '/' ? '?returnTo=' + encodeURIComponent(req.originalUrl.slice(bp.length)) : ''));
  if (req.path.startsWith('/cal/')) return next();
  return res.status(401).send('Sign in required');
});
router.use(require('./routes/app')(csrfCheck));
router.use('/admin', require('./routes/admin'));

app.use(bp || '/', router);

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).render('error', { title: status === 403 ? 'Not allowed' : 'Something went wrong', message: status < 500 ? err.message : 'An unexpected error occurred. It has been logged.' });
});

if (require.main === module) {
  app.listen(config.port, () => console.log(`[ecr2] listening on ${config.port} at ${bp || '/'} (auth: ${config.auth.mode})`));
}
module.exports = app;
