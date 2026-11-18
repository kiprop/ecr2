// Microsoft Graph (application permissions) for email and directory search.
// Mail needs Mail.Send; directory search needs User.Read.All. Both need admin consent.
// With MAIL_SENDER blank, mail is only logged.
const config = require('./config');

let cached = null;
async function token() {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const body = new URLSearchParams({ client_id: config.auth.clientId, client_secret: config.auth.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const r = await fetch(`https://login.microsoftonline.com/${config.auth.tenantId}/oauth2/v2.0/token`, { method: 'POST', body });
  if (!r.ok) throw new Error(`Graph token ${r.status}`);
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

let smtp = null;
function smtpTransport() {
  if (!smtp) {
    const c = config.mail.smtp;
    smtp = require('nodemailer').createTransport({ host: c.host, port: c.port, secure: c.secure, requireTLS: !c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined });
  }
  return smtp;
}

function mailMode() { return config.mail.sender ? 'graph' : (config.mail.smtp ? 'smtp' : 'log'); }

// Returns 'sent' | 'logged' | 'failed'. With throwOnError, failures throw (used by the test button).
async function sendMail(to, subject, html, { throwOnError = false } = {}) {
  const mode = mailMode();
  if (mode === 'log') { console.log(`[mail:log-only] to=${to} subject="${subject}"`); return 'logged'; }
  if (mode === 'smtp') {
    try {
      await smtpTransport().sendMail({ from: config.mail.smtp.from, to, subject, html });
      return 'sent';
    } catch (e) { console.error('[mail:smtp]', e.message); if (throwOnError) throw e; return 'failed'; }
  }
  try {
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mail.sender)}/sendMail`, {
      method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false }),
    });
    if (!r.ok) throw new Error(`sendMail ${r.status} ${await r.text()}`);
    return 'sent';
  } catch (e) { console.error('[mail:graph]', e.message); if (throwOnError) throw e; return 'failed'; }
}

async function searchUsers(q) {
  if (q.trim().length < 2) return [];
  const safe = q.replace(/"/g, '');
  const url = `https://graph.microsoft.com/v1.0/users?$search="displayName:${safe}" OR "mail:${safe}"&$select=displayName,mail,jobTitle&$top=8`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}`, ConsistencyLevel: 'eventual' } });
  if (!r.ok) throw new Error(`users ${r.status}`);
  const j = await r.json();
  return (j.value || []).filter((u) => u.mail && /@pedaids\.org$/i.test(u.mail)).map((u) => ({ name: u.displayName, email: u.mail.toLowerCase(), title: u.jobTitle || '' }));
}

module.exports = { sendMail, searchUsers, mailMode };
