# Anantam Ventures — construction management

A web app for running an apartment construction business: bills and expenses (read by AI), vendors, budgets, flat sales and
customer payment schedules, follow-ups, site progress and photos, materials, labour and wages, a document vault, users and an audit log.

## Features

| Area | What you get |
|---|---|
| **Projects** | Run several sites at once. After login you pick a project (admins see **+ New project**); a switcher in the header changes project. Every record, report, CSV export and file belongs to one project; the daily digest groups items by project. Admins see all projects, other users only those they're a member of (enforced in the API on every read, write and file download). |
| **Guest bill upload link** | Each project has a public, unguessable link (`/u/<token>`, 192-bit) where anyone — site staff, suppliers — can submit a bill (PDF/photo, max 10 MB) with **remarks**, their name and phone, **without an account**. It lands in that project as *Needs review* (with a **Guest** badge) and goes through the same AI reading/categorisation. Admins copy, disable or regenerate the link from **Projects** (a new link kills the old one immediately). Abuse limits: 5 uploads / 10 min per IP, 20 / hour per link, magic-byte file check; bad and disabled links look identical. |
| **Login** | Username **or** email → 6-digit code emailed (10 min, single use, 5 attempts, 3 sends / 15 min). HttpOnly session cookie (12 h). |
| **Bills & expenses** | **Needs review** filter with count. Upload PDF/photo → **Azure AI Document Intelligence** reads vendor, bill #, dates, subtotal, GST, total → auto category (vendor default → keyword rules → **Azure OpenAI gpt-4.1-mini** fallback only when no rule matches; also suggests a phase) → bill created as *Needs review*. Duplicate detection. Paid / Partially paid / Unpaid tracking, payment mode, "Mark paid". Vendors learn their default category. |
| **Vendors & contractors** | Contact, GSTIN, bank/UPI, default category. |
| **Budgets** | Budget per category / phase; dashboard shows budget vs actual with overruns highlighted. |
| **Flats & bookings** | Unit inventory (block, floor, type, area, price, status). Booking auto-sets flat to Booked / Sold / Available. |
| **Customer payment schedule** | Construction-linked stages, due dates, receipts, receivables & overdue tracking. |
| **Follow-ups & tasks** | Assignee, due date, priority, status. |
| **Site** | Milestones with % complete, site photo log (camera capture on phones), material stock in/out with low-stock alerts, labour register, attendance, monthly wage report (OT + advances). |
| **Document vault** | Approvals, agreements, NOCs with expiry alerts. |
| **Dashboard** | Spend, unpaid/overdue bills, receivables, progress, wages, spend by category/phase/month, alerts. |
| **Daily digest email** | 09:00 IST: bills/customer payments due in 3 days, overdue tasks, expiring documents — per role. |
| **Admin** | Users & roles, audit log (400-day retention), CSV export everywhere. |

Roles: **admin** (everything), **accountant** (finance + sales), **engineer** (site, bills upload, tasks), **viewer** (read-only).

## Architecture

```mermaid
flowchart LR
  U[Browser / phone] --> SWA[Static Web Apps Free<br/>React + Functions API]
  SWA --> C[(Cosmos DB<br/>free tier)]
  SWA --> B[(Blob Storage<br/>bills/photos/docs)]
  SWA --> DI[Document Intelligence F0<br/>bill reading]
  SWA -.->|only if no keyword rule matches| AOAI[Azure OpenAI gpt-4.1-mini<br/>category fallback]
  SWA --> ACS[Communication Services<br/>Email OTP + digest]
  GH[GitHub Actions cron] -->|daily digest| SWA
```

- `web/` — React 19 + Vite + TypeScript. Screens are generated from the API's entity schema (`GET /api/schema`).
- `api/` — Azure Functions v4 (Node/TypeScript). Entity definitions, validation and roles live in `api/src/schema.ts`.
- `infra/` — Bicep + `deploy.sh`.
- **Projects:** `project` docs (name, location, status, start date, notes, `members`, `shareToken`, `shareEnabled`) are managed via `/api/projects`.
  All other entities except users and the audit log carry a `projectId`; the web app sends `?project=<id>` and the API checks
  membership (`api/src/projects.ts`). New files are stored under `p/<projectId>/…` so downloads are checked against the project.
  On first start after the upgrade, existing data is moved into a **Default project** (idempotent; existing non-admin users become members).
  Same Cosmos container and partition key (`/type`) — no extra cost.
- **Guest upload:** `GET /api/public/projects/{token}` and `POST /api/public/upload/{token}` (no login, `api/src/functions/guest.ts`);
  rate-limit counters are short-lived Cosmos docs with TTL.

## Cost (target ≈ $0–2 / month, hard ceiling $150)

| Resource | Tier | Expected monthly cost |
|---|---|---|
| Static Web Apps (site + API) | Free | $0 |
| Cosmos DB | Free tier, **capped at 1000 RU/s** (`totalThroughputLimit`) | $0 |
| Blob Storage | Standard LRS, private | < $0.10 for a few GB |
| Document Intelligence | F0 (500 pages / month free, first 2 pages per bill) | $0 |
| Communication Services Email | Pay-per-use (~$0.00025 / email) | < $0.05 |
| Azure OpenAI (gpt-4.1-mini, South India, GlobalStandard 10K TPM) | Pay-per-token, S0 has no fixed fee; only called when keyword rules don't match (~600 tokens ≈ $0.0003 / call) | < $0.50 (≈ ₹40) even at 1,000 such bills |
| GitHub Actions (CI, deploy, cron) | Public repo | $0 |

Guard-rails: subscription budget ($20 default) with 50/80/100 % and forecast alerts, Cosmos throughput cap,
`deploy.sh` refuses to run against any subscription other than `240b9dac-…` or to create a second (paid) Cosmos account,
and the Visual Studio subscription's spending limit stops all charges at the $150 credit.
**If you exceed 500 bill pages/month**, Document Intelligence F0 returns errors (no charge); bills are still saved for manual entry.
The OpenAI fallback is fail-safe: if `AZURE_OPENAI_*` settings are missing, the call errors or takes over 10 s, or the answer
isn't a known category, the bill is simply categorised *Miscellaneous*. The 10K tokens/min capacity also limits worst-case spend.
The public guest link is rate-limited (per IP and per link) so it can't burn the Document Intelligence free quota or OpenAI tokens;
an admin can disable or regenerate a leaked link instantly.

## Local development

```bash
cd api && cp local.settings.sample.json local.settings.json   # set BOOTSTRAP_ADMIN_EMAIL
npm install && npm start                                       # Functions on :7071 (needs Azure Functions Core Tools)
cd ../web && npm install && npm run dev                        # http://localhost:5173
```

Without Azure settings the API runs fully offline: data in `api/.data/db.json`, files in `api/.data/files`,
emails (including OTP codes) written to `api/.data/dev-mail.log`, AI parsing and the OpenAI category fallback skipped.

Tests: `cd api && npm test`.

## Deploy (when you're ready)

```bash
az login
ADMIN_EMAIL=you@example.com ./infra/deploy.sh
```

Then add the three repo secrets it prints (`AZURE_STATIC_WEB_APPS_API_TOKEN`, `APP_URL`, `JOB_KEY`) and push to `main`.
Sign in with `ADMIN_EMAIL`, then add other users under **Admin → Users**.

`deploy.sh` is safe to rerun: it reuses the existing `JWT_SECRET` / `JOB_KEY` from the Static Web App instead of regenerating them.
To add only the OpenAI fallback to an existing deployment, deploy `infra/openai.bicep` and merge its three
`AZURE_OPENAI_*` settings with `az staticwebapp appsettings set` (that command merges settings, it doesn't replace them).
