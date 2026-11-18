# ECR 2.0 · EGPAF Compliance Registry

Tracks each country office's statutory, governance, delegated-authority and banking obligations across the programme life cycle: **Establish** (registration), **Operate** (annual cycle and registers) and **Close out** (gated four-stage plan).

Node.js 20 · Express · server-rendered EJS · PostgreSQL 16 · Microsoft Entra sign-in · Docker.

## What it does

| Area | Behaviour |
|---|---|
| Sign-in | Microsoft Entra (OIDC, PKCE). Invitation only: an account must exist in ECR. `SUPER_ADMINS` are created as administrators on first sign-in. |
| Roles | Administrator, HQ reviewer, Leadership (view only), Country Director, Country focal point. Directors and focal points see only their countries. |
| Annual cycle | Opens for every operating country on the 1st of the cycle month (Settings), from the standard template with local wording per country. Directors sign off when every item is done or not applicable. |
| Registers | Registration, board, powers of attorney, bank accounts. Dates in the registers create tasks automatically (renewals, term ends, missing COI declarations, POA expiry, yearly bank confirmation) within the planning horizon. |
| Review | Country staff submit with evidence; HQ accepts or returns with a comment. Accepting updates the register (for example a new POA expiry). |
| Changes | "Report a change" (signatories, board, POA, registration) goes to HQ; accepting applies it to the register. A board change also creates the notice-to-authority task. |
| Close-out | Requested by the country, approved by HQ. Stages unlock in order; the country is then marked closed and read-only. |
| Restricted data | POA and banking are flagged restricted; account numbers are masked to the last four digits; document downloads in those areas are logged. |
| Audit | Append-only `events` table (database trigger blocks update/delete). Exports per country as CSV. |
| Calendar | Built from open items; CSV export and a personal Outlook subscription link (`/cal/<token>.ics`). |
| Worker | Hourly: syncs register deadlines, opens the cycle, sends reminders at the configured lead times and a Monday digest (via Microsoft Graph when `MAIL_SENDER` is set; otherwise logged). |

## Deploy on dhda.pedaids.org/ecr2

ECR 2.0 runs beside v1 (`/compliance`, port 8302) as a separate stack with its own database. It does not touch v1.

1. **Entra**: in the app registration gap-node uses, add the Web redirect URI `https://dhda.pedaids.org/ecr2/auth/callback`.
2. **Server**:
   ```bash
   cd /opt && sudo mkdir ecr2 && sudo chown dhda_root:dhda_root ecr2
   git clone https://github.com/kiprop/ecr2.git ecr2 && cd ecr2
   cp .env.example .env && chmod 600 .env
   sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 48)|; s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 24)|" .env
   grep -E '^ENTRA_(TENANT_ID|CLIENT_ID|CLIENT_SECRET)=' /opt/gap-node/.env   # copy these three values
   nano .env        # paste the Entra values, set SUPER_ADMINS=<your @pedaids.org email>
   docker compose up -d --build
   curl -sI http://127.0.0.1:8304/ecr2/ | grep -i location   # expect /ecr2/login
   ```
3. **nginx**: paste `deploy/nginx-ecr2.conf` into the 443 server block, then `sudo nginx -t && sudo systemctl reload nginx`.
4. **Sample data for testers (optional)**: `docker compose exec app node scripts/seed-demo.js` adds eight sample countries with registers and a part-finished cycle. Sample people have `.demo@pedaids.org` addresses and cannot sign in; invite real testers from **Users & access** and give them countries. Before going live with real data, clear it with `docker compose exec app node scripts/seed-demo.js --clear` (keeps templates, settings and real users).

Updating: `git pull && docker compose up -d --build`. Migrations run on start.

Backups: `docker compose exec -T db pg_dump -U ecr2 ecr2 | gzip > ~/ecr2-$(date +%F).sql.gz` and the `ecr2_blobs` volume (uploaded evidence).

## Optional Microsoft Graph features

Both use the same app registration with **application** permissions and admin consent:

| Feature | Permission | Setting |
|---|---|---|
| Email reminders, digest, invitations | `Mail.Send` | `MAIL_SENDER=<mailbox>@pedaids.org` |
| Directory search when inviting | `User.Read.All` | `DIRECTORY_SEARCH=true` |

Consider an application access policy so `Mail.Send` can only send as the one mailbox.

## Local development

```bash
npm install
# PostgreSQL running locally with a database/user from .env (or defaults ecr/ecr)
AUTH_MODE=mock npm run migrate && npm run seed && npm run seed:demo
AUTH_MODE=mock BASE_PATH=/ecr2 npm start   # http://localhost:3000/ecr2, pick a sample person
```
`AUTH_MODE=mock` refuses to start when `NODE_ENV=production`.
