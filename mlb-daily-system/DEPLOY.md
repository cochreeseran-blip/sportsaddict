# Deploy: two services, one database

Slatefinder runs as **two Railway services that share one Postgres**:

| Service | Start command | Role |
|---------|---------------|------|
| **web** | `npm run start:web` (`node server.js`) | Serves `slatefinder.lol` (admin/finder, owner-only) and `slateaddict.com` (customer app), plus the JSON API. Never runs the pipeline. |
| **engine** | `npm run start:worker` (`node worker.js`) | The always-on brain: hourly MLB-only research refresh, the 8:00 AM Pacific generation run (odds + record + board lock + daily email), the closing-line pull near first pitch, grading, and manual-refresh handling. |

They communicate only through the shared database (`system_status` for run
state and the manual-refresh signal; the ledger / digests / games for
everything else). No HTTP between them.

## Railway setup

1. **Postgres**: one instance. Both services get the same `DATABASE_URL`.
2. **web service**: deploy this repo, start command `npm run start:web`.
   Attach both custom domains to it:
   - `slatefinder.lol` → set env `ADMIN_HOST=slatefinder.lol`
   - `slateaddict.com` → set env `APP_HOST=slateaddict.com`
   The host header selects the surface; admin routes 404 on the customer host.
3. **engine service**: deploy the same repo again as a second service, start
   command `npm run start:worker`. It only needs `DATABASE_URL` plus the data
   keys below. It exposes just `/healthz`.
4. Run migrations once (either service runs them idempotently on boot; or
   `npm run migrate` as a one-off).

## Environment variables

Shared (both services): `DATABASE_URL`.

Engine only (the metered/external calls live here):
- `ODDS_PROVIDER` (default `the-odds-api`) and `ODDS_API_KEY`
- `RESEND_API_KEY`, `NEWSLETTER_FROM`, `OWNER_EMAIL`, `POSTAL_ADDRESS`, `APP_BASE_URL`
- `GENERATION_HOUR_PT` (default `8`) — the Pacific hour the board generates
- `EMAIL_LINK_SECRET` (optional; auto-generated + persisted if unset)

Web only:
- `ADMIN_HOST`, `APP_HOST` (the two custom domains)
- `PAYWALL_ENABLED` (`true` to gate research to member tier; default off)
- `RESEND_API_KEY` / `NEWSLETTER_FROM` / `APP_BASE_URL` / `POSTAL_ADDRESS`
  (only if the admin email-compose feature is used; the scheduled daily
  email is the engine's job)

## Odds budget

The default odds provider (The Odds API) is metered at 500 requests/month, so
the engine pulls odds **exactly twice a day**: the 8 AM PT generation and the
closing-line pull. A paid live-odds feed drops into `lib/sources/oddsProvider.js`
(a `mode: 'live'` provider) and is selected with `ODDS_PROVIDER` — no other code
changes. Hourly refreshes and manual refreshes are always MLB-Stats-only (free,
unmetered).
