// Sign-in: Microsoft Entra (OIDC, auth code + PKCE). Mock mode for local development only.
const express = require('express');
const { Issuer, generators } = require('openid-client');
const config = require('./config');
const db = require('./db');
const { audit } = require('./domain');

const router = express.Router();
const HINT = 'ecr2.hint';
function readHint(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(HINT + '='));
  return m ? decodeURIComponent(m.slice(HINT.length + 1)) : '';
}
const redirectUri = () => `${config.appBaseUrl}${config.basePath}/auth/callback`;

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = Issuer.discover(`https://login.microsoftonline.com/${config.auth.tenantId}/v2.0`).then((issuer) => new issuer.Client({
      client_id: config.auth.clientId,
      client_secret: config.auth.clientSecret,
      redirect_uris: [redirectUri()],
      response_types: ['code'],
    }));
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

router.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const personas = config.auth.mode === 'mock'
    ? await db.q(`SELECT id, name, role FROM users WHERE status <> 'inactive' ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'reviewer' THEN 2 WHEN 'leader' THEN 3 WHEN 'director' THEN 4 ELSE 5 END, name`)
    : [];
  res.render('login', { signedOut: req.query.signedout === '1', personas, title: 'Sign in', error: req.query.error || '', returnTo: req.query.returnTo || '' });
});

router.get('/auth/login', async (req, res, next) => {
  if (config.auth.mode === 'mock') return res.redirect('/login');
  req.cookies_hint = readHint(req);
  if (req.query.switch === '1') res.clearCookie(HINT, { path: config.basePath || '/' });
  try {
    const client = await getClient();
    const codeVerifier = generators.codeVerifier();
    const state = generators.state();
    const nonce = generators.nonce();
    req.session.oidc = { codeVerifier, state, nonce, returnTo: req.query.returnTo || '' };
    const url = client.authorizationUrl({
      scope: 'openid profile email', code_challenge: generators.codeChallenge(codeVerifier), code_challenge_method: 'S256', state, nonce,
      // Silent single sign-on when the browser already has a Microsoft session; the account picker only after an explicit sign-out or "switch account".
      ...(req.query.switch === '1' ? { prompt: 'select_account' } : {}),
      // Tell Microsoft which account to use, so it skips the picker even without a browser session.
      ...(req.query.switch !== '1' && /^[^@\s]+@pedaids\.org$/i.test(req.cookies_hint || '') ? { login_hint: req.cookies_hint } : {}),
      domain_hint: 'pedaids.org',
    });
    req.session.save((err) => (err ? next(err) : res.redirect(url)));
  } catch (e) { next(e); }
});

router.get('/auth/callback', async (req, res, next) => {
  try {
    const o = req.session.oidc;
    if (!o) return res.redirect('/login?error=expired');
    const client = await getClient();
    const params = client.callbackParams(req);
    const tokens = await client.callback(redirectUri(), params, { code_verifier: o.codeVerifier, state: o.state, nonce: o.nonce });
    const claims = tokens.claims();
    const email = String(claims.preferred_username || claims.email || claims.upn || '').toLowerCase();
    delete req.session.oidc;
    await finishSignIn(req, res, { email, name: claims.name, oid: claims.oid, returnTo: o.returnTo });
  } catch (e) { next(e); }
});

async function finishSignIn(req, res, { email, name, oid, returnTo }) {
  let user = await db.one(`SELECT * FROM users WHERE email=$1`, [email]);
  if (!user && config.auth.superAdmins.includes(email)) {
    user = await db.one(`INSERT INTO users (email, name, role, status) VALUES ($1,$2,'admin','active') RETURNING *`, [email, name || email]);
    await audit(user.id, 'user.bootstrap', `${email} created as administrator from SUPER_ADMINS`);
  }
  if (!user || user.status === 'inactive') {
    await audit(null, 'signin.denied', email || 'unknown account');
    return res.status(403).render('noaccess', { title: 'No access', email });
  }
  await db.q(`UPDATE users SET status='active', last_login_at=now(), entra_oid=COALESCE($2, entra_oid), name=CASE WHEN status='invited' AND $3::text IS NOT NULL THEN $3 ELSE name END WHERE id=$1`, [user.id, oid || null, name || null]);
  await audit(user.id, 'signin', email);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    res.cookie(HINT, email, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: config.basePath || '/', maxAge: 1000 * 60 * 60 * 24 * 180 });
    req.session.save(() => res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'));
  });
}

router.post('/auth/mock', express.urlencoded({ extended: false }), async (req, res) => {
  if (config.auth.mode !== 'mock') return res.status(404).send('Not found');
  const u = await db.one(`SELECT * FROM users WHERE id=$1`, [req.body.user_id]);
  if (!u) return res.redirect('/login');
  await finishSignIn(req, res, { email: u.email, name: u.name, oid: null });
});

router.post('/auth/logout', (req, res) => {
  const uid = req.session.userId;
  req.session.destroy(async () => {
    res.clearCookie('ecr2.sid', { path: config.basePath || '/' });
    if (uid) await audit(uid, 'signout', '');
    res.redirect('/login?signedout=1');
  });
});

module.exports = { router };
