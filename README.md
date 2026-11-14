# Loyalty & Rewards — Shopify app

Multi-store loyalty program: points, rewards (real Shopify discount codes), emails, referrals,
review rewards, delivery-based crediting, analytics, and a customisable storefront widget / rewards
page with a theme-editor-style visual editor.

## Run it

```bash
npm install
npx prisma migrate deploy
npm run dev            # Shopify CLI: tunnel + app + webhooks (and the background jobs)
```

No Redis and no separate worker: delayed point releases, queued emails and the 6-hourly maintenance run
inside the web server (see **Background jobs** below).

Config lives in `.env` (see `.env.example`): `DATABASE_URL` (Neon), `SMTP_*`, and
`APP_ENCRYPTION_KEY` (encrypts stored Judge.me tokens and peppers login-code hashes; required in
production). Shopify keys are injected by `shopify app dev`.
`docker compose up --build` runs the web app (which includes the background jobs).

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
| Background jobs (scheduler, email queue) | `app/queue/scheduler.server.js`, `emailqueue.server.js`, `boot.server.js` |
| Storefront (app proxy `/apps/loyalty/*`) | `app/routes/proxy.*` |
| Widget model, renderer, storefront runtime | `app/lib/widget/*` |
| Theme app extension (embed + page block) | `extensions/loyalty-widget` |
| Merchant UI | `app/routes/app.*` |

## Key decisions

- **Tenancy.** Every business table has `storeId … onDelete: Cascade`; the store is always derived
  from the verified Shopify session / app-proxy signature, never from request input. `shop/redact`
  calls `deleteStore()`, which removes the store, all its data and its sessions.
- **Points timing.** Merchant picks the trigger (paid / fulfilled / delivered) and a hold of N days.
  `0` credits immediately. Pending awards sit in the database with their release time; the in-app scheduler
  wakes at that time (see **Background jobs**), so a restart or deploy can't strand points.
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


## Email brand and reward codes

- **Emails → Sending settings → Your brand**: logo (https link; "fills the whole header" for a banner image), brand colour, corner radius,
  header/button/footer colours, footer title and text (`{email}` = reply-to address or store email). Emails you haven't customised use it;
  customised ones keep their own design. Stored in `StoreSettings.emailBrand`.
- **Rules → Reward codes in one order**: by default a reward code can't be combined with another reward code (or other order
  discounts); "Allow several codes together" creates new codes with Shopify's combine options switched on.

**Choosing which reward codes can be held together** (Rules → "Using several reward codes together", when stacking is on): a grid of
every pair of rewards, all ticked by default. Shopify can't name specific codes, so this is enforced when a code is issued: a customer
can't redeem a reward that is unticked against one of their unused codes (`Reward.noStackWith`, `app/services/stacking.server.js`).

## How points, refunds and accounts work (after the review fixes)

- **Order amount.** Points come from the order's `subtotal_price` (after discounts, before shipping/tax) as it was at checkout. Never
  `current_subtotal_price`, which already has refunds taken off. Order edits after checkout don't change points.
- **Refunds.** Refunded amount is tracked on the order; the share still kept is `1 − refunded ÷ order amount`. Before release the award is
  just credited at that share. After release, points are reversed down to `floor(award × kept share)`, measured against what was actually
  credited, minus what's already been reversed. A cancel or a completed return takes back whatever remains. Replays do nothing.
- **Accounts.** One account per Shopify customer per store. An email-code (or imported) account is merged into a Shopify customer only when
  Shopify itself reports that customer's email as verified. Otherwise the Shopify customer gets a separate account without that email.
- **Fast-checkout IP list** needs `TRUSTED_IP_HEADER` (see `.env.example`); without it the list can't be saved and requests are refused.
- **Tests:** `npm run test:unit` (no database) and `npm run test:smoke` (needs the database).

## Background jobs (no Redis)

The database is the queue and one timer, inside the web server process, wakes the app when something is due.

- **What runs.** Delayed point releases (`PointsAward.releaseAt`), queued emails (`EmailJob` table), and a maintenance
  pass at start and every 6 hours (points expiry, stuck redemptions, expired codes, login-code clean-up, expiry
  reminders, Judge.me reviews, pruning finished jobs).
- **No polling.** The scheduler asks the database "when is the next thing due?" only at start, after doing work, and
  when something is queued (then it already knows the time). Between events the app doesn't touch the database, so a
  serverless one can sleep. Release times are snapped up to `SCHEDULER_SNAP_MINUTES` (default 5) so many awards share a wake-up.
- **Nothing is lost.** On every start (deploy, crash, wake) it runs everything that came due meanwhile. Late, never lost.
- **Emails.** Claimed with `FOR UPDATE SKIP LOCKED` and a 2-minute lease, so two instances never send the same row and a
  crash mid-send is picked up again. Retries back off 30s, 2m, 10m, 1h, 6h, then the email is marked FAILED (visible, with
  a "Retry" button, on the Emails page). Paced to `EMAIL_MAX_PER_MINUTE` (default 120). Queueing is idempotent per `dedupeKey`.
- **A machine that sleeps.** Set `DISABLE_SCHEDULER=1` and `CRON_SECRET`, and have an outside scheduler call
  `POST /internal/tick` (every few minutes for emails, `?maintenance=1` about every 6 hours) with `Authorization: Bearer <CRON_SECRET>`.
