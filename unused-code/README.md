# Unused code (kept on purpose)

Points are now spent only in the Shiprocket checkout: Shiprocket takes the amount off itself, so we no
longer create Shopify discount codes. Everything that did that is kept here, not deleted, in case it is
needed again.

| What | Where it was | Notes |
| --- | --- | --- |
| Redeem endpoint for the storefront widget | `routes/proxy.redeem.jsx` | was `app/routes/` |
| Shiprocket "lookup" and "redeem" (code) endpoints | `routes/integrations.shiprocket.$storeId.lookup.jsx`, `...redeem.jsx` | was `app/routes/`. The points / block / unblock endpoints Shiprocket really uses stay. |
| Customer-account "redeem" branch | `routes/customer-account.api.redeem-branch.js.txt` | was inside `customer-account.api.jsx` |
| Widget "redeem" and "coupons" blocks | `widget/render-redeem-and-coupons.js.txt` | was `app/lib/widget/render.js` |
| Rules page: reward types that make codes, "combine reward codes" grid | `admin/rules-code-rewards.jsx.txt` | was `app/routes/app.rules.jsx` |

Still in place because other things use them: `app/services/redeem.server.js` (the code-making logic and the
background job that expires old codes), the `Reward`/`Redemption` tables, and `app/services/stacking.server.js`.
To bring codes back: move the routes into `app/routes/`, paste the text files back where they came from, and add the
reward types back to the Rules page.
