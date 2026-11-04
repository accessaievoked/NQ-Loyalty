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
- `node scripts/smoke-test-features.mjs` — email login, referrals, reviews, delivery/returns, checkout accounts, emails, analytics

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
| Judge.me reviews | `app/services/integrations.server.js`, `app/routes/integrations.judgeme.$storeId.jsx` |
| Delivery + returns (from Shopify) | `app/services/orders.server.js`, `app/services/returns.server.js` |
| Analytics | `app/services/analytics.server.js`, `app/routes/app.analytics.jsx` |
| Account-page tab + side drawer | `app/lib/widget/runtime.js`, `app/lib/widget/render.js` |
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
- **Delivery and returns come from Shopify.** Delivery uses fulfillment `shipment_status` and
  events. A return in progress (`REQUESTED` / `OPEN`) holds waiting points; a completed one
  (`CLOSED`) cancels them for good (or reverses ones already credited); a declined or cancelled
  one lets crediting resume. No carrier integration is needed.
- **Whose points?** A shopper with a store account earns on their own account. A guest checkout
  earns on the account open in the widget (a signed `loyalty_ref` on the cart); a forged reference
  is ignored.
- **Reviews.** Judge.me reviews arrive by webhook and a 6-hourly poll that only exists while a
  store has Judge.me connected. The token is AES-GCM encrypted, and field names are parsed
  tolerantly because the payload is not fully documented.

## New customer accounts (shopify.com/…/account)

Shopify's new customer accounts can't run theme scripts, so "My Rewards" ships as two UI extensions
(`extensions/rewards-page`, `extensions/rewards-profile-block`) sharing `extensions/shared`:

- **My Rewards page** – a full page in the account. Add it to the menu in
  *Settings → Customer accounts → Customize* (add the "My Rewards" menu item).
- **Loyalty rewards block** – a points card with a "View rewards" button for the Profile and Orders
  pages. Place it in the same editor (*Add block → Loyalty rewards*).

Both call `POST /customer-account/api`, authenticated by Shopify's session token (a JWT verified with
the app secret in `app/services/customeraccount.server.js`), so the customer is the signed-in one —
no OTP. Run `shopify app dev` (or `npm run deploy`) to push the extensions. Discount codes are shown
as selectable text (extensions cannot use the clipboard).

## Importing existing members

Customers → **Import customers**:

- **From Shopify** – creates a rewards account for every customer already in the store (no points, no welcome bonus).
- **From a CSV** – `email` is required; `first_name`, `last_name` (or `name`) and `points` are optional. Up to 2,000 rows per file,
  re-running a file never gives the points twice. Imported accounts start unverified; when Shopify later reports the same
  *verified* email they merge into that customer with their points intact.

## Emails

15 ready-made designs (Emails → Design). Spacing is exact: the theme sets side spacing and an optional row spacing for every
row, and each block can override space above/below/sides. Every slider has a box for typing the exact pixel value.

## Fast checkout (Shiprocket Checkout / fastrr)

Fast-checkout apps replace Shopify's checkout, so the widget and pasted codes can't run there. Rules → **Fast checkout** turns on a
server-to-server API that their checkout calls after it has verified the shopper's phone:

- `POST /integrations/shiprocket/:storeId/lookup` `{ phone?, email? }` → `{ found, customer: { firstName, points }, canRedeem, offers[], currency, display }`
- `POST /integrations/shiprocket/:storeId/redeem` `{ phone?, email?, rewardId, points?, requestId }` → `{ ok, code, pointsSpent, discountAmount, balance, … }`

Auth: the store's secret key in `x-api-key` (or `Authorization: Bearer`), optionally restricted to Shiprocket's IPs. Phones match on
their last 10 digits; a phone shared by two accounts matches nobody. `requestId` makes retries safe. The code is single-use and not
tied to a Shopify login. **Shiprocket's own spec isn't public** — this is our side of the contract; Shiprocket's checkout team
enables it (the setup card has a ready-to-send message) and may ask for different field names, which are all in
`app/services/fastcheckout.server.js`.

