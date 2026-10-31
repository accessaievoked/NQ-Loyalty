# Loyalty & Rewards — Shopify app

Multi-store loyalty program: points, rewards (real Shopify discount codes), emails, referrals,
review rewards, delivery-based crediting, analytics, and a customisable storefront widget / rewards
page with a theme-editor-style visual editor.

## Run it

```bash
npm install
npm run redis          # Redis in Docker (needs Docker Desktop running)
npx prisma migrate deploy
npm run dev            # Shopify CLI: tunnel + app + webhooks
npm run worker         # second terminal: background jobs
```

Config lives in `.env` (see `.env.example`): `DATABASE_URL` (Neon), `REDIS_URL`, `SMTP_*`, and
`APP_ENCRYPTION_KEY` (encrypts stored Judge.me tokens and peppers login-code hashes; required in
production). Shopify keys are injected by `shopify app dev`.
`docker compose up --build` runs Redis + web + worker together.

Check everything end to end against the database (each uses a throwaway store and deletes it):

- `node scripts/smoke-test.mjs` — points, orders, refunds, redeem, expiry
- `node scripts/smoke-test-features.mjs` — email login, referrals, reviews, Shiprocket, analytics

## How it's organised

| Area | Where |
| --- | --- |
| Schema (tenant root is `Store`; everything cascades) | `prisma/schema.prisma` |
| Ledger: idempotent, row-locked, FIFO expiry | `app/services/ledger.server.js` |
| Order events → awards → hold → release; refunds/cancels | `app/services/orders.server.js` |
| Customer identity rules | `app/services/customers.server.js` |
| Email-code (OTP) login and sessions | `app/services/identity.server.js` |
| Referrals | `app/services/referrals.server.js` |
| Redeem → Shopify discount code (refund on failure) | `app/services/redeem.server.js` |
| Judge.me / Shiprocket | `app/services/integrations.server.js`, `app/routes/integrations.*` |
| Analytics | `app/services/analytics.server.js`, `app/routes/app.analytics.jsx` |
| Emails (SMTP, deduped) / reminders | `mailer`, `notify`, `credit`, `reminders` `.server.js` |
| Editable email templates (blocks or HTML) | `app/lib/email/templates.js`, `app/services/emailtemplates.server.js`, `app/routes/app.emails.jsx` |
| Developer source (full CSS/HTML, rollback) | `app/services/devsource.server.js`, `app/routes/app.developer.jsx` |
| Queue + worker (BullMQ) | `app/queue/queue.server.js`, `worker/index.js` |
| Storefront (app proxy `/apps/loyalty/*`) | `app/routes/proxy.*` |
| Widget model, renderer, storefront runtime | `app/lib/widget/*` |
| Theme app extension (embed + page block) | `extensions/loyalty-widget` |
| Merchant UI | `app/routes/app.*` |

## Key decisions

- **Tenancy.** Every business table has `storeId … onDelete: Cascade`; the store is always derived
  from the verified Shopify session / app-proxy signature, never from request input. `shop/redact`
  calls `deleteStore()`, which removes the store, all its data and its sessions.
- **Points timing.** Merchant picks the trigger (paid / fulfilled / delivered) and a hold of N days.
  `0` credits immediately. Pending awards are scheduled as delayed BullMQ jobs; a sweep (on worker start, then every 6 hours)
  re-checks the database so a lost job or Redis restart can't strand points.
- **Ledger.** Append-only rows with idempotency keys; the customer row is locked per write so
  concurrent redeems can't overspend. Refunds post proportional `REVERSAL` rows (balance may go
  negative if points were already spent).
- **Login.** Store-account shoppers are identified by Shopify's signed `logged_in_customer_id`.
  Everyone else can log in with a 6-digit emailed code; the browser keeps an opaque token whose hash
  is stored. A verified email links to (or becomes) the one account per email per store.
- **Referrals.** One code per member, one application per friend (before their first order). Both
  sides are paid once, when the friend's first qualifying order is credited, and reversed if that
  order is cancelled or fully refunded.
- **Currency.** Everything is stored and transacted in the store's own currency (read from Shopify and refreshed every few hours). Admin reports can be viewed in another currency (INR, USD, EUR, GBP, AED, AUD, CAD) by multiplying by a daily live rate or the merchant's own rate; rewards, codes and anything customers see are never converted.
- **Per-store design.** The widget config, developer source and email templates all live in that
  store's own rows and cascade-delete with the store, so every store has its own look.
- **Developer source.** The generated CSS and HTML shells can be edited and stored per store. Saves
  are validated; the renderer falls back to the generated version if a shell is unusable; and the
  database keeps a last-working copy (initially the generated default) plus the previous version.
- **Email templates.** Each email kind renders from the store's template (blocks or HTML) or the
  built-in default; a broken template falls back to the default, and the login email must contain
  `{{code}}`.
- **Integrations.** Judge.me reviews arrive by webhook and a 6-hourly poll that only exists while a store has Judge.me connected; Shiprocket calls a
  token-protected webhook. Credentials are AES-GCM encrypted. Field names are parsed tolerantly
  because neither provider fully documents its payloads publicly.
