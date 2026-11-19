// Branded HTML emails in the ECR / GAP theme. Table layout and inline styles so they render in Outlook.
const config = require('./config');

const TEAL = '#0F5A64';
const ORANGE = '#E39A2F';
const FONT = "'Segoe UI', Inter, Arial, sans-serif";
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const appUrl = (path = '/') => `${config.appBaseUrl}${config.basePath}${path}`;

const CHIP = {
  overdue: ['#FBEBEB', '#A33A3A', 'Overdue'],
  due: ['#FDF1E1', '#8A5A12', 'Due soon'],
  returned: ['#FDF1E1', '#8A5A12', 'Returned by HQ'],
  todo: ['#E8F1F2', TEAL, 'To do'],
  info: ['#E8F1F2', TEAL, ''],
};
const chip = (kind, label) => {
  const [bg, fg, def] = CHIP[kind] || CHIP.info;
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:12px;font-weight:600;padding:3px 10px;border-radius:12px">${esc(label || def)}</span>`;
};

const button = (href, label) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px"><tr>
<td bgcolor="${TEAL}" style="background:${TEAL};border-radius:6px">
<a href="${esc(href)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${esc(label)}</a>
</td></tr></table>`;

// One item: title, country and due date, with a status chip
const itemCard = ({ title, country, area, due, status, statusLabel, note }) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;border:1px solid #D5E1E2;border-left:4px solid ${status === 'overdue' ? '#A33A3A' : ORANGE};border-radius:6px">
<tr><td style="padding:14px 16px;font-family:${FONT}">
${status ? `<div style="margin-bottom:8px">${chip(status, statusLabel)}</div>` : ''}
<div style="font-size:16px;font-weight:600;color:#12343a;line-height:1.35">${esc(title)}</div>
<div style="font-size:13px;color:#5b6b70;margin-top:4px">${[country, area, due ? `Due ${due}` : null].filter(Boolean).map(esc).join(' &middot; ')}</div>
${note ? `<div style="font-size:14px;color:#3d5358;margin-top:10px;padding:10px 12px;background:#F7FAFA;border-radius:4px">${esc(note)}</div>` : ''}
</td></tr></table>`;

// The page around every email
function layout({ preheader = '', heading, body, cta, footer }) {
  const logo = appUrl('/public/img/egpaf-logo.png');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#F1F5F5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F5" style="background:#F1F5F5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="padding:20px 28px;border-bottom:3px solid ${ORANGE}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td><img src="${logo}" alt="Elizabeth Glaser Pediatric AIDS Foundation" height="44" style="display:block;height:44px;border:0"></td>
  <td align="right" style="font-family:${FONT};font-size:13px;color:${TEAL};font-weight:700;letter-spacing:.04em">ECR 2.0<br><span style="font-weight:400;color:#5b6b70;letter-spacing:0">Compliance Registry</span></td>
  </tr></table>
</td></tr>
<tr><td style="padding:28px 28px 8px;font-family:${FONT};font-size:15px;line-height:1.6;color:#1f2a30">
  <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:${TEAL};font-weight:700">${esc(heading)}</h1>
  ${body}
  ${cta ? button(cta.href, cta.label) : ''}
</td></tr>
<tr><td style="padding:20px 28px 26px;font-family:${FONT};font-size:12px;line-height:1.5;color:#7a8a90;border-top:1px solid #E6EEEF">
  ${footer || 'You are receiving this because you have access to ECR 2.0, the EGPAF Compliance Registry.'}<br>
  <a href="${appUrl('/')}" style="color:${TEAL}">dhda.pedaids.org/ecr2</a> &middot; Sign in with your EGPAF Microsoft account.
</td></tr>
</table>
</td></tr></table></body></html>`;
}

const p = (t) => `<p style="margin:0 0 12px">${t}</p>`;
const first = (name) => esc(String(name || '').split(' ')[0] || 'there');

// Each email ECR sends
const T = {
  invite: ({ name, by, role, countries }) => ({
    subject: 'You have access to the EGPAF Compliance Registry (ECR 2.0)',
    html: layout({
      preheader: `${by} has given you access as ${role}.`,
      heading: 'Welcome to ECR 2.0',
      body: p(`Hello ${first(name)},`) + p(`${esc(by)} has given you access to ECR 2.0, the EGPAF Compliance Registry, as <b>${esc(role)}</b> for <b>${esc(countries)}</b>.`)
        + p('ECR keeps each country office’s registration, board, powers of attorney and bank accounts in one place, with reminders before every deadline.')
        + p('There is no new password: sign in with your EGPAF Microsoft account.'),
      cta: { href: appUrl('/'), label: 'Open ECR 2.0' },
    }),
  }),
  hqReminder: ({ name, by, item, country, area, due, message, href }) => ({
    subject: `Reminder from HQ: ${item} (${country})`,
    html: layout({
      preheader: `${by} sent a reminder about ${item}.`,
      heading: 'A reminder from HQ',
      body: p(`Hello ${first(name)},`) + p(`${esc(by)} sent a reminder about this item for ${esc(country)}:`)
        + itemCard({ title: item, country, area, due, status: 'todo', note: message }),
      cta: { href, label: 'Open the item' },
    }),
  }),
  deadline: ({ name, item, country, area, due, days, returned, href }) => {
    const overdue = days < 0;
    const when = overdue ? `${-days} day${days === -1 ? '' : 's'} overdue` : `due in ${days} day${days === 1 ? '' : 's'}`;
    return {
      subject: overdue ? `Overdue: ${item} (${country})` : `Due in ${days} days: ${item} (${country})`,
      html: layout({
        preheader: `${item} for ${country} is ${when}.`,
        heading: overdue ? 'An item is overdue' : 'A deadline is coming up',
        body: p(`Hello ${first(name)},`) + p(`This item for ${esc(country)} is <b>${esc(when)}</b>. Open it, attach the evidence and submit it for review.`)
          + itemCard({ title: item, country, area, due, status: overdue ? 'overdue' : (returned ? 'returned' : 'due') }),
        cta: { href, label: 'Open the item' },
        footer: 'You get reminders for the countries you are responsible for, at the lead times HQ sets, then weekly once an item is overdue.',
      }),
    };
  },
  digest: ({ name, reviewCount, items, summary }) => ({
    subject: 'Your week in the EGPAF Compliance Registry',
    html: layout({
      preheader: reviewCount ? `${reviewCount} submissions are waiting for review.` : 'What needs you this week.',
      heading: 'Your week in ECR 2.0',
      body: p(`Hello ${first(name)},`)
        + (reviewCount ? p(`<b>${reviewCount}</b> submission${reviewCount === 1 ? ' is' : 's are'} waiting for your review.`) : '')
        + (summary ? p(esc(summary)) : '')
        + (items && items.length ? p('Here is what needs you in the next 30 days:') + items.map((i) => itemCard(i)).join('') : ''),
      cta: { href: appUrl('/'), label: 'Open ECR 2.0' },
      footer: 'The weekly digest goes out on Mondays. The administrator can switch it off in Settings.',
    }),
  }),
  test: ({ mode }) => ({
    subject: 'ECR 2.0 test email',
    html: layout({
      preheader: 'Email delivery is working.',
      heading: 'Email delivery is working',
      body: p(`This is a test from ECR 2.0, sent by ${esc(String(mode).toUpperCase())}. Invitations, reminders and the weekly digest will look like this.`)
        + itemCard({ title: 'Example: File the annual return with the registering authority', country: 'Lesotho', area: 'Annual cycle', due: '31 Mar 2027', status: 'due' }),
      cta: { href: appUrl('/'), label: 'Open ECR 2.0' },
    }),
  }),
};

// Plain-text version for mail clients that do not show HTML
const toText = (html) => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
  .replace(/<(br|\/p|\/div|\/h1|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .split('\n').map((l) => l.trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim())).join('\n').trim();

module.exports = { ...T, toText, appUrl };
