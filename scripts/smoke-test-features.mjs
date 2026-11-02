// Checks for OTP login, referrals, Judge.me, delivery/returns, analytics and encryption against the
// real database, using a throwaway store (emails disabled, so nothing is sent).
// Run: node scripts/smoke-test-features.mjs
import "dotenv/config";
import assert from "node:assert/strict";
import prisma from "../app/db.server.js";
import { hashCode, decrypt, encrypt, hashToken } from "../app/lib/crypto.server.js";
import { IdentityError, requestOtp, verifyOtp, sessionCustomer, revokeSession, findOrCreateByVerifiedEmail } from "../app/services/identity.server.js";
import { upsertCustomer } from "../app/services/customers.server.js";
import { handleOrderEvent, handleRefund } from "../app/services/orders.server.js";
import { ReferralError, applyReferralCode, ensureReferralCode, referralInfo } from "../app/services/referrals.server.js";
import { ensureIntegration, processReview } from "../app/services/integrations.server.js";
import { loadAnalytics } from "../app/services/analytics.server.js";
import { postTransaction } from "../app/services/ledger.server.js";
import { deleteStore } from "../app/services/store.server.js";

const shop = `feat-${Date.now()}.myshopify.com`;
let n = 0;
const ok = (m) => console.log(`  âœ“ ${++n}. ${m}`);
const bal = async (id) => (await prisma.customer.findUnique({ where: { id } })).pointsBalance;
const noAdmin = { graphql: async () => ({ json: async () => ({ data: { customers: { nodes: [] } } }) }) };

let store = await prisma.store.create({
  data: {
    shop, currency: "USD", name: "Feature Test",
    settings: { create: { earnTrigger: "PAID", holdDays: 0, emailsEnabled: false } },
    earnRules: {
      create: [
        { name: "per $", type: "PURCHASE_PER_CURRENCY", value: 1 },
        { name: "welcome", type: "SIGNUP", value: 25 },
        { name: "friend", type: "REFERRAL_FRIEND", value: 100, minOrderAmount: 20 },
        { name: "referrer", type: "REFERRAL_REFERRER", value: 200, minOrderAmount: 20 },
        { name: "review", type: "REVIEW", value: 40 },
      ],
    },
  },
  include: { settings: true },
});
const reload = async () => (store = await prisma.store.findUnique({ where: { id: store.id }, include: { settings: true } }));
const order = (id, customerId, amount, extra = {}) => ({
  id, name: `#${id}`, email: `c${customerId}@example.invalid`, currency: "USD", subtotal_price: String(amount),
  processed_at: new Date().toISOString(), customer: { id: customerId, first_name: "T" }, discount_codes: [], ...extra,
});

try {
  // ---- crypto
  assert.equal(decrypt(encrypt("secret-token-123")), "secret-token-123");
  assert.notEqual(encrypt("x"), encrypt("x"));
  ok("encryption round-trips and uses a fresh IV each time");

  // ---- OTP
  const email = "otp.user@example.invalid";
  const plant = async (code, over = {}) =>
    prisma.otpChallenge.create({ data: { storeId: store.id, email, codeHash: hashCode(store.id, email, code), expiresAt: new Date(Date.now() + 600000), ...over } });

  await assert.rejects(verifyOtp({ store, admin: noAdmin, email, code: "123456" }), IdentityError); // nothing requested
  const ch = await plant("424242");
  for (let i = 0; i < 5; i++) await assert.rejects(verifyOtp({ store, admin: noAdmin, email, code: "000000" }), IdentityError);
  await assert.rejects(verifyOtp({ store, admin: noAdmin, email, code: "424242" }), /Too many/); // locked after 5 misses
  ok("wrong codes are counted; after 5 misses even the right code is refused");

  await prisma.otpChallenge.update({ where: { id: ch.id }, data: { consumedAt: new Date() } });
  await plant("111111", { expiresAt: new Date(Date.now() - 1000) });
  await assert.rejects(verifyOtp({ store, admin: noAdmin, email, code: "111111" }), IdentityError);
  ok("expired codes are refused");

  await plant("654321");
  const v = await verifyOtp({ store, admin: noAdmin, email, code: "654321" });
  assert.ok(v.token && v.token.length > 30);
  assert.equal(v.customer.email, email);
  assert.equal(v.customer.shopifyCustomerId, null);
  assert.equal(v.customer.emailVerified, true);
  assert.equal(await bal(v.customer.id), 25); // welcome bonus
  await assert.rejects(verifyOtp({ store, admin: noAdmin, email, code: "654321" }), IdentityError); // single use
  const stored = await prisma.loyaltySession.findFirst({ where: { customerId: v.customer.id } });
  assert.equal(stored.tokenHash, hashToken(v.token));
  assert.ok(!JSON.stringify(stored).includes(v.token)); // raw token never stored
  ok("correct code logs in: account created with welcome bonus, code is single-use, only the token hash is stored");

  assert.equal((await sessionCustomer(store.id, v.token)).id, v.customer.id);
  assert.equal(await sessionCustomer(store.id, "garbage"), null);
  assert.equal(await sessionCustomer("another-store", v.token), null);
  await revokeSession(store.id, v.token);
  assert.equal(await sessionCustomer(store.id, v.token), null);
  ok("session token resolves its customer, is rejected for other stores, and logout revokes it");

  const again = await findOrCreateByVerifiedEmail(store, noAdmin, email);
  assert.equal(again.id, v.customer.id);
  ok("logging in again with the same email reuses the account (one account per email)");

  for (let i = 0; i < 3; i++) await prisma.otpChallenge.create({ data: { storeId: store.id, email: "spam@example.invalid", codeHash: "x", expiresAt: new Date(Date.now() + 1000) } });
  await assert.rejects(requestOtp({ store, email: "spam@example.invalid" }), /Too many codes/);
  await assert.rejects(requestOtp({ store, email: "not-an-email" }), IdentityError);
  ok("sending codes is rate-limited per email; invalid emails are rejected");

  // ---- identity merge: OTP account later appears in Shopify with the same email
  const adopted = await upsertCustomer(store.id, { shopifyCustomerId: "9001", email, emailVerified: false, firstName: "Otto" });
  assert.equal(adopted.id, v.customer.id);
  assert.equal(adopted.shopifyCustomerId, "9001");
  assert.equal(await prisma.customer.count({ where: { storeId: store.id, email } }), 1);
  assert.equal(await bal(adopted.id), 25);
  ok("when Shopify reports the same email, the email-login account is adopted (no duplicate, points kept)");

  // ---- referrals
  const alice = await upsertCustomer(store.id, { shopifyCustomerId: "1", email: "alice@example.invalid", emailVerified: true, firstName: "Alice" });
  const bob = await upsertCustomer(store.id, { shopifyCustomerId: "2", email: "bob@example.invalid", emailVerified: true, firstName: "Bob" });
  const aliceCode = await ensureReferralCode(alice);
  assert.match(aliceCode, /^[A-Z0-9]{4,10}$/);
  assert.equal(await ensureReferralCode(alice), aliceCode);
  await assert.rejects(applyReferralCode({ store, customer: alice, code: aliceCode }), ReferralError);
  await assert.rejects(applyReferralCode({ store, customer: bob, code: "NOSUCHCODE" }), ReferralError);
  ok("referral codes are stable, self-referral and unknown codes are refused");

  await reload(); // rules are inactive until switched on? they're active in this store
  await applyReferralCode({ store, customer: bob, code: aliceCode.toLowerCase() });
  await assert.rejects(applyReferralCode({ store, customer: bob, code: aliceCode }), /already used/);
  const info = await referralInfo(store, alice);
  assert.equal(info.invited, 1);
  assert.equal(await bal(bob.id), 25 /* welcome only */);
  ok("a friend applies a code once; nothing is paid until their first order");

  await handleOrderEvent(store, "orders/paid", order(3001, "2", 10)); // below the 20 minimum
  assert.equal((await prisma.referral.findUnique({ where: { refereeId: bob.id } })).status, "PENDING");
  assert.equal(await bal(alice.id), 25);
  ok("an order below the qualifying minimum doesn't trigger the referral");

  await handleOrderEvent(store, "orders/paid", order(3002, "2", 50));
  await handleOrderEvent(store, "orders/paid", order(3002, "2", 50)); // webhook replay
  assert.equal((await prisma.referral.findUnique({ where: { refereeId: bob.id } })).status, "REWARDED");
  assert.equal(await bal(bob.id), 25 + 10 + 50 + 100); // welcome + order 3001 pts + order 3002 pts + friend bonus
  assert.equal(await bal(alice.id), 25 + 200);
  ok("first qualifying order pays friend +100 and referrer +200 exactly once (replay-safe)");

  await handleOrderEvent(store, "orders/paid", order(3003, "2", 60));
  assert.equal(await bal(alice.id), 225);
  ok("later orders from the friend don't pay the referrer again");

  const bobBefore = await bal(bob.id);
  await handleOrderEvent(store, "orders/cancelled", order(3002, "2", 50, { cancelled_at: new Date().toISOString() }));
  assert.equal((await prisma.referral.findUnique({ where: { refereeId: bob.id } })).status, "REVERSED");
  assert.equal(await bal(alice.id), 25);
  assert.equal(await bal(bob.id), bobBefore - 50 - 100);
  ok("cancelling the qualifying order reverses the order points and both referral rewards");

  const late = await upsertCustomer(store.id, { shopifyCustomerId: "3", email: "carl@example.invalid", emailVerified: true });
  await handleOrderEvent(store, "orders/paid", order(3004, "3", 30));
  await assert.rejects(applyReferralCode({ store, customer: late, code: aliceCode }), /new customers/);
  ok("a code can't be applied after the customer has already ordered");

  // ---- Judge.me
  await ensureIntegration(store.id, "JUDGEME");
  const dana = await upsertCustomer(store.id, { shopifyCustomerId: "4", email: "dana@example.invalid", emailVerified: true });
  const d0 = await bal(dana.id); // includes the welcome bonus
  const review = (id, over = {}) => ({ id, rating: 5, product_external_id: "p1", reviewer: { email: "dana@example.invalid", external_id: "4" }, ...over });
  assert.match(await processReview(store, review(1, { rating: 3 })), /below/);
  assert.equal(await bal(dana.id), d0);
  assert.match(await processReview(store, review(2)), /rewarded 40/);
  assert.equal(await bal(dana.id), d0 + 40);
  assert.match(await processReview(store, review(2)), /already/);
  assert.match(await processReview(store, review(3)), /already/); // same product again
  assert.match(await processReview(store, review(4, { product_external_id: "p2" })), /rewarded/);
  assert.equal(await bal(dana.id), d0 + 80);
  assert.match(await processReview(store, review(5, { reviewer: { email: "stranger@example.invalid" } })), /not a verified member/);
  assert.match(await processReview(store, review(6, { curated: "spam", product_external_id: "p9" })), /spam/);
  ok("reviews: rating threshold, once per product, strangers and spam ignored");

  // ---- delivery + returns straight from Shopify (no carrier integration needed)
  const OS = await import("../app/services/orders.server.js");
  const RT = await import("../app/services/returns.server.js");
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { earnTrigger: "DELIVERED", holdDays: 0 } });
  await reload();
  const erin = await upsertCustomer(store.id, { shopifyCustomerId: "5", email: "erin@example.invalid", emailVerified: true });
  const e0 = await bal(erin.id);
  const paid = order(4001, "5", 40);
  await handleOrderEvent(store, "orders/paid", paid);
  await handleOrderEvent(store, "orders/fulfilled", { ...paid, updated_at: new Date().toISOString() });
  assert.equal(await bal(erin.id), e0);                                                    // fulfilled isn't delivered
  await OS.handleFulfillmentUpdate(store, { order_id: 4001, shipment_status: "in_transit", updated_at: "2026-10-01T10:00:00Z" });
  assert.equal(await bal(erin.id), e0);
  assert.equal((await prisma.order.findFirst({ where: { storeId: store.id, shopifyOrderId: "4001" } })).shipmentStatus, "in_transit");
  await OS.handleFulfillmentUpdate(store, { order_id: 4001, shipment_status: "delivered", updated_at: "2026-10-02T10:00:00Z" });
  assert.equal(await bal(erin.id), e0 + 40);                                               // delivered → credited
  await OS.handleFulfillmentUpdate(store, { order_id: 4001, shipment_status: "delivered", updated_at: "2026-10-09T10:00:00Z" });
  await OS.handleFulfillmentEvent(store, { order_id: 4001, status: "delivered", happened_at: "2026-10-10T10:00:00Z" });
  assert.equal(await bal(erin.id), e0 + 40);                                               // repeats never double-credit
  assert.equal((await prisma.order.findFirst({ where: { storeId: store.id, shopifyOrderId: "4001" } })).deliveredAt.toISOString().slice(0, 10), "2026-10-02"); // first delivery time kept
  ok("delivery from Shopify: fulfillments/update 'delivered' credits once; transit/repeat pings change nothing");

  // return window after delivery, then a return in progress HOLDS the points
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { holdDays: 7 } });
  await reload();
  const fay = await upsertCustomer(store.id, { shopifyCustomerId: "6", email: "fay@example.invalid", emailVerified: true });
  const f0 = await bal(fay.id);
  const due = async (orderId) => {
    const o = await prisma.order.findFirst({ where: { storeId: store.id, shopifyOrderId: String(orderId) } });
    const a = await prisma.pointsAward.findUnique({ where: { orderId: o.id } });
    await prisma.pointsAward.update({ where: { id: a.id }, data: { releaseAt: new Date(Date.now() - 1000) } });
    return a.id;
  };
  const p2 = order(4002, "6", 40);
  await handleOrderEvent(store, "orders/paid", p2);
  await OS.handleFulfillmentUpdate(store, { order_id: 4002, shipment_status: "delivered", updated_at: new Date().toISOString() });
  const award2 = await prisma.pointsAward.findFirst({ where: { customerId: fay.id } });
  assert.equal(award2.status, "PENDING");
  assert.ok(award2.releaseAt.getTime() > Date.now() + 6 * 86400000);
  assert.equal(await bal(fay.id), f0);
  ok("return window: points stay pending for 7 days after Shopify reports delivery");

  assert.match(await RT.handleReturnWebhook(store, "RETURNS_REQUEST", { order_id: 4002 }, null), /held/);
  const id2 = await due(4002);
  assert.equal(await OS.releaseAward(id2), null);                                          // the window passed, but a return is open
  assert.equal(await OS.releaseDueAwards() >= 0, true);
  assert.equal((await prisma.pointsAward.findUnique({ where: { id: id2 } })).status, "PENDING");
  assert.equal(await bal(fay.id), f0);
  await RT.handleReturnWebhook(store, "RETURNS_APPROVE", { order_id: 4002 }, null);
  assert.equal(await OS.releaseAward(id2), null);                                          // still in progress after approval
  assert.match(await RT.handleReturnWebhook(store, "RETURNS_DECLINE", { order_id: 4002 }, null), /resume/);
  assert.equal(await bal(fay.id), f0 + 40);                                                // declined → credited straight away
  ok("a return in progress holds waiting points; if it's declined they're credited");

  // a completed return cancels waiting points for good
  const gus = await upsertCustomer(store.id, { shopifyCustomerId: "7", email: "gus@example.invalid", emailVerified: true });
  const g0 = await bal(gus.id);
  await handleOrderEvent(store, "orders/paid", order(4003, "7", 60));
  await OS.handleFulfillmentUpdate(store, { order_id: 4003, shipment_status: "delivered", updated_at: new Date().toISOString() });
  await RT.handleReturnWebhook(store, "RETURNS_REQUEST", { order_id: 4003 }, null);
  assert.match(await RT.handleReturnWebhook(store, "RETURNS_CLOSE", { order_id: 4003 }, null), /cancelled/);
  const id3 = await due(4003);
  assert.equal(await OS.releaseAward(id3), null);
  assert.equal((await prisma.pointsAward.findUnique({ where: { id: id3 } })).status, "CANCELLED");
  assert.equal(await bal(gus.id), g0);                                                     // never credited
  await OS.releaseDueAwards();
  assert.equal(await bal(gus.id), g0);
  ok("a completed return cancels the waiting points entirely; they're never credited, even later");

  // …and takes points back if they were already credited
  const hal = await upsertCustomer(store.id, { shopifyCustomerId: "8", email: "hal@example.invalid", emailVerified: true });
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { holdDays: 0 } });
  await reload();
  const h0 = await bal(hal.id);
  await handleOrderEvent(store, "orders/paid", order(4004, "8", 50));
  await OS.handleFulfillmentUpdate(store, { order_id: 4004, shipment_status: "delivered", updated_at: new Date().toISOString() });
  assert.equal(await bal(hal.id), h0 + 50);
  await RT.handleReturnWebhook(store, "RETURNS_CLOSE", { order_id: 4004 }, null);
  assert.equal(await bal(hal.id), h0);
  await RT.handleReturnWebhook(store, "RETURNS_CLOSE", { order_id: 4004 }, null);          // replayed webhook
  assert.equal(await bal(hal.id), h0);
  ok("a completed return after crediting takes the points back once (replay-safe)");

  // payload without an order id → looked up from Shopify by the return's id
  const lookup = { graphql: async () => ({ json: async () => ({ data: { return: { id: "gid://shopify/Return/9", status: "OPEN", order: { id: "gid://shopify/Order/4005" } } } }) }) };
  await handleOrderEvent(store, "orders/paid", order(4005, "8", 10));
  assert.match(await RT.handleReturnWebhook(store, "RETURNS_REQUEST", { admin_graphql_api_id: "gid://shopify/Return/9" }, lookup), /held/);
  assert.equal((await prisma.order.findFirst({ where: { storeId: store.id, shopifyOrderId: "4005" } })).returnStatus, "REQUESTED");
  assert.match(await RT.handleReturnWebhook(store, "RETURNS_REQUEST", { nothing: true }, null), /order unknown/);
  ok("return webhooks: order id taken from the payload or looked up from Shopify; unknown orders are ignored safely");

  // ---- which account gets the points at checkout
  const { signRef, verifyRef } = await import("../app/lib/crypto.server.js");
  const open = await upsertCustomer(store.id, { shopifyCustomerId: "21", email: "open@example.invalid", emailVerified: true });   // account open in the widget
  const buyer = await upsertCustomer(store.id, { shopifyCustomerId: "22", email: "buyer@example.invalid", emailVerified: true }); // shopper's own account
  const withRef = (id, customer, ref) => ({ ...order(id, customer.shopifyCustomerId, 100), customer: { id: customer.shopifyCustomerId, state: customer.state, email: customer.email, first_name: "T" }, note_attributes: ref ? [{ name: "loyalty_ref", value: ref }] : [] });
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { earnTrigger: "PAID", holdDays: 0 } });
  await reload();
  const ref = signRef(store.id, open.id);
  assert.equal(verifyRef(store.id, ref), open.id);
  assert.equal(verifyRef(store.id, `${open.id}.forged`), null);
  assert.equal(verifyRef("another-store", ref), null);
  const o0 = await bal(open.id), b0 = await bal(buyer.id);
  // 1) signed in with their own account → THEIR account, even though another was open in the widget
  await handleOrderEvent(store, "orders/paid", withRef(5001, { shopifyCustomerId: "22", state: "enabled", email: "buyer@example.invalid" }, ref));
  assert.equal(await bal(buyer.id), b0 + 100);
  assert.equal(await bal(open.id), o0);
  // 2) guest checkout (Shopify makes a "disabled" customer record) → the account open in the widget
  await handleOrderEvent(store, "orders/paid", withRef(5002, { shopifyCustomerId: "23", state: "disabled", email: "guest@example.invalid" }, ref));
  assert.equal(await bal(open.id), o0 + 100);
  assert.equal(await prisma.customer.count({ where: { storeId: store.id, email: "guest@example.invalid" } }), 0); // no stray guest account either
  // 3) a forged or foreign reference is ignored → falls back to Shopify's own record
  await handleOrderEvent(store, "orders/paid", withRef(5003, { shopifyCustomerId: "24", state: "disabled", email: "g2@example.invalid" }, `${open.id}.forged`));
  assert.equal(await bal(open.id), o0 + 100);
  assert.equal(await bal((await prisma.customer.findFirst({ where: { storeId: store.id, shopifyCustomerId: "24" } })).id), 125); // 100 + the welcome bonus
  // 4) no reference at all → Shopify's record, as before
  await handleOrderEvent(store, "orders/paid", withRef(5004, { shopifyCustomerId: "25", state: "disabled", email: "g3@example.invalid" }, null));
  assert.equal(await bal((await prisma.customer.findFirst({ where: { storeId: store.id, shopifyCustomerId: "25" } })).id), 125);
  ok("checkout: signed-in shoppers earn on their own account; guests earn on the account open in the widget; forged refs are ignored");
  // ---- custom HTML layout: every block must be reachable (regression: coupons were missing)
  const { normalizeConfig, missingTemplateBlocks, STARTER_HTML } = await import("../app/lib/widget/defaults.js");
  const oldStarter = STARTER_HTML.replace("{{block:earn}}\n", "").replace("{{block:coupons}}\n", "");
  assert.ok(!oldStarter.includes("block:coupons"));
  const upgraded = normalizeConfig({ custom: { mode: "html", html: oldStarter } });
  assert.equal(upgraded.custom.html, STARTER_HTML);
  assert.deepEqual(missingTemplateBlocks(upgraded), []);
  const edited = normalizeConfig({ custom: { mode: "html", html: `${oldStarter}\n<p>my edit</p>` } });
  assert.ok(edited.custom.html.includes("my edit") && !edited.custom.html.includes("block:coupons")); // user edits are never overwritten
  assert.ok(missingTemplateBlocks(edited).includes("coupons"));
  ok("custom HTML: unedited old starter upgrades to include coupons; edited templates are kept and flagged");

  // ---- recent activity: redeem rows open to show their code, inside a fixed-height scroll box
  const { renderBlocks, widgetCss } = await import("../app/lib/widget/render.js");
  const cfg = normalizeConfig({ blocks: [{ type: "history", settings: { height: 200 } }] });
  const view = { loggedIn: true, customer: { points: 1 }, history: [
    { label: "Order #1", points: 10, date: "2026-10-01", redeem: null },
    { label: "Reward redeemed · $5 off", points: -500, date: "2026-10-02", redeem: { code: "LOY-ABC123", status: "ACTIVE", expiresAt: "2026-12-01" } },
    { label: "Reward redeemed · old", points: -100, date: "2026-09-02", redeem: { code: "LOY-OLD999", status: "USED", expiresAt: null } },
  ] };
  const htmlOut = renderBlocks(cfg, view);
  assert.ok(htmlOut.includes("LOY-ABC123") && htmlOut.includes('data-action="copy"') && !htmlOut.includes('data-action="apply"'));   // active code: copyable (no apply button)
  assert.ok(htmlOut.includes("LOY-OLD999") && htmlOut.includes(">Used<"));               // used code: visible, badged
  assert.equal((htmlOut.match(/<details>/g) || []).length, 2);                          // only redeem rows open
  assert.ok(htmlOut.includes("max-height:200px") && htmlOut.includes("lw-scroll"));
  assert.ok(!widgetCss(cfg).includes("scrollbar-width: none"));
  assert.ok(widgetCss({ ...cfg, theme: { ...cfg.theme, hideScrollbars: true } }).includes("scrollbar-width: none"));
  ok("recent activity: redeem rows expand to the code (active/used), list scrolls in a fixed box, scrollbar can be hidden");

  // ---- email templates
  const E = await import("../app/lib/email/templates.js");
  const ET = await import("../app/services/emailtemplates.server.js");
  for (const kind of Object.keys(E.EMAIL_KINDS)) {
    const out = E.renderEmail(kind, E.defaultEmailTemplate(kind), E.EMAIL_KINDS[kind].sample);
    assert.ok(out.html.includes("<table") && out.subject.length > 0 && !out.html.includes("{{"), `default ${kind}`);
  }
  const evil = E.renderEmail("points_earned", undefined, { ...E.EMAIL_KINDS.points_earned.sample, first_name: '<script>alert(1)</script>', reason: '"><img src=x onerror=alert(1)>' });
  assert.ok(!/<script>|<img src=x/i.test(evil.html));
  const noExpiry = E.renderEmail("points_earned", undefined, { ...E.EMAIL_KINDS.points_earned.sample, expires_at: "" });
  assert.ok(!noExpiry.html.includes("These points expire") && E.renderEmail("points_earned", undefined, E.EMAIL_KINDS.points_earned.sample).html.includes("These points expire"));
  ok("emails: defaults render for every kind, variable values are escaped, conditional blocks hide when empty");

  const customHtmlOut = E.renderEmail("redeemed", { mode: "html", subject: "Hey {{first_name}}", html: '<p onclick="x()">Code {{code}}</p><script>bad()</script><a href="javascript:alert(1)">x</a>' }, E.EMAIL_KINDS.redeemed.sample);
  assert.ok(customHtmlOut.html.includes("Code LOY-8F2A91C0DE") && !/<script|onclick|javascript:/i.test(customHtmlOut.html));
  assert.equal(customHtmlOut.subject, "Hey Alex");
  ok("emails: custom HTML gets variables filled and scripts/handlers/javascript: links removed");

  const noCode = await ET.saveEmailTemplate(store.id, "otp", { blocks: [{ type: "heading", settings: { text: "Hello" } }] });
  assert.equal(noCode.ok, false);
  assert.match(noCode.errors.join(" "), /\{\{code\}\}/);
  assert.equal((await ET.saveEmailTemplate(store.id, "nope", {})).ok, false);
  assert.equal((await ET.saveEmailTemplate(store.id, "redeemed", { mode: "html", html: "  " })).ok, false);
  ok("emails: the login email can't be saved without {{code}}; empty HTML and unknown emails are refused");

  const custom1 = E.defaultEmailTemplate("redeemed");
  custom1.subject = "Your code {{code}} is here";
  assert.equal((await ET.saveEmailTemplate(store.id, "redeemed", custom1)).ok, true);
  const sent = await ET.renderStoreEmail(store, "redeemed", { firstName: "Zed", rewardName: "R", code: "LOY-1", expiresAt: "" });
  assert.equal(sent.subject, "Your code LOY-1 is here");
  assert.ok((await ET.getEmailTemplate(store.id, "redeemed")).customised);
  // a merchant's own HTML is sent as written, even with no variables
  await prisma.emailTemplate.update({ where: { storeId_kind: { storeId: store.id, kind: "redeemed" } }, data: { mode: "html", html: "<p>plain</p>" } });
  assert.equal((await ET.renderStoreEmail(store, "redeemed", { code: "LOY-1" })).html, "<p>plain</p>");
  // but a login email that lost its {{code}} (bad data) must fall back, or nobody could log in
  await prisma.emailTemplate.create({ data: { storeId: store.id, kind: "otp", mode: "html", subject: "Hi", html: "<p>no code</p>" } });
  const otpSend = await ET.renderStoreEmail(store, "otp", { code: "135790" });
  assert.ok(otpSend.html.includes("135790"));
  await ET.resetEmailTemplate(store.id, "otp");
  await ET.resetEmailTemplate(store.id, "redeemed");
  assert.equal((await ET.getEmailTemplate(store.id, "redeemed")).customised, false);
  const otpHtml = await ET.saveEmailTemplate(store.id, "otp", { mode: "html", subject: "Code", html: "<p>No code here</p>" });
  assert.equal(otpHtml.ok, false);
  ok("emails: custom template is used when sending, a broken one falls back to the default, reset restores the default");

  // ---- developer source (full CSS/HTML) with last-working-copy rollback
  const D = await import("../app/services/devsource.server.js");
  const { getWidgetConfig } = await import("../app/services/store.server.js");
  const R = await import("../app/lib/widget/render.js");
  assert.ok(D.validateSource({ css: "@import url(x);" }).length);
  assert.ok(D.validateSource({ shell: "<div>{{content}}</div>" }).some((e) => /data-action="toggle"/.test(e)));
  assert.ok(D.validateSource({ shell: '<button data-action="toggle"></button>' }).some((e) => /\{\{content\}\}/.test(e)));
  assert.ok(D.validateSource({ shell: '<button onclick="x()" data-action="toggle"></button>{{content}}' }).length);
  assert.ok(D.validateSource({ shell: '<script>x</script><button data-action="toggle"></button>{{content}}' }).length);
  assert.deepEqual(D.validateSource({ css: ".lw-launcher{opacity:.9}", shell: R.DEFAULT_SHELL, pageShell: R.DEFAULT_PAGE_SHELL }), []);
  ok("developer source: unsafe or unusable code is refused before it can go live");

  let s0 = await prisma.storeSettings.findUnique({ where: { storeId: store.id } });
  assert.equal(getWidgetConfig(s0).dev, null); // off by default
  const gen = (await D.getDevSource(store.id)).generated;
  assert.ok(gen.css.includes(".lw-launcher") && gen.shell === R.DEFAULT_SHELL);
  const v1 = { css: ".lw-launcher{outline:3px solid red}", shell: R.DEFAULT_SHELL, pageShell: "" };
  assert.equal((await D.saveDevSource(store.id, { ...v1, enabled: true })).ok, true);
  s0 = await prisma.storeSettings.findUnique({ where: { storeId: store.id } });
  assert.ok(getWidgetConfig(s0).dev.css.includes("outline:3px"));
  assert.ok(s0.devLastGood && s0.devLastGood.generated && s0.devLastGood.css.includes(".lw-launcher")); // safe fallback exists from the first publish
  ok("developer source: publishing goes live and records the generated default as the first working copy");

  assert.equal((await D.markWorking(store.id)).ok, true);
  const v2 = { css: ".lw-launcher{display:none}", shell: R.DEFAULT_SHELL, pageShell: "" }; // a developer breaks it
  await D.saveDevSource(store.id, { ...v2, enabled: true });
  s0 = await prisma.storeSettings.findUnique({ where: { storeId: store.id } });
  assert.ok(getWidgetConfig(s0).dev.css.includes("display:none"));
  assert.ok(s0.devPrevious.css.includes("outline:3px"));
  assert.equal((await D.saveDevSource(store.id, { css: "@import url(evil)", shell: "", enabled: true })).ok, false);
  s0 = await prisma.storeSettings.findUnique({ where: { storeId: store.id } });
  assert.ok(s0.devCss.includes("display:none")); // a refused save changes nothing
  await D.revertToLastWorking(store.id);
  s0 = await prisma.storeSettings.findUnique({ where: { storeId: store.id } });
  assert.ok(getWidgetConfig(s0).dev.css.includes("outline:3px") && !getWidgetConfig(s0).dev.css.includes("display:none"));
  await D.revertToPrevious(store.id);
  s0 = await prisma.storeSettings.findUnique({ where: { storeId: store.id } });
  assert.ok(s0.devCss.includes("display:none")); // undo flips back to what was replaced
  ok("developer source: breaking it is recoverable — revert to last working copy, undo last publish, refused saves change nothing");

  await D.disableDevSource(store.id);
  s0 = await prisma.storeSettings.findUnique({ where: { storeId: store.id } });
  assert.equal(getWidgetConfig(s0).dev, null);
  assert.ok(s0.devCss); // code kept, just not used
  const visual = JSON.stringify(s0.widgetConfig);
  assert.ok(!visual.includes("display:none")); // never leaks into the visual config
  const cfgWithDev = { theme: { primary: "#123456" }, dev: { css: "x{}", shell: "", pageShell: "" } };
  const norm = (await import("../app/lib/widget/defaults.js")).normalizeConfig(cfgWithDev);
  assert.equal(norm.dev.css, "x{}");
  const filled = R.fillShell(R.DEFAULT_SHELL, { root_classes: "a", panel_classes: "b", panel_hidden: "hidden", expanded: "false", launcher_label: '<b>"x"', launcher_inner: "<i>I</i>", store_name: "S", content: "<p>C</p>" }, ["panel_hidden", "launcher_inner", "content"]);
  assert.ok(filled.includes("<p>C</p>") && filled.includes("&lt;b&gt;") && !filled.includes('<b>"x"'));
  ok("developer source: can be switched off without losing code; shell placeholders escape values, content stays HTML");

  // ---- referral revenue + customer referral stats (Alice referred Bob; Bob's order 3002 was cancelled)
  const RS = await import("../app/services/referralstats.server.js");
  const aliceStats = await RS.customerReferralStats(store.id, alice.id);
  assert.equal(aliceStats.totals.referred, 1);
  assert.equal(aliceStats.friends[0].status, "REVERSED");
  assert.equal(aliceStats.friends[0].orders, 2);          // 3001 and 3003 count; the cancelled 3002 doesn't
  assert.equal(aliceStats.friends[0].revenue, 70);        // 10 + 60
  assert.equal(aliceStats.totals.revenue, 70);
  const bobStats = await RS.customerReferralStats(store.id, bob.id);
  assert.equal(bobStats.referredBy.id, alice.id);
  assert.equal(bobStats.totals.referred, 0);
  assert.equal((await RS.referralCounts(store.id, [alice.id, bob.id])).get(alice.id), 1);
  await handleRefund(store, { id: 7001, order_id: 3003, refund_line_items: [{ subtotal: "20.00" }] });
  assert.equal((await RS.customerReferralStats(store.id, alice.id)).totals.revenue, 50);   // refunds come off the revenue
  assert.equal((await RS.totalReferralRevenue(store.id)).revenue, 50);
  ok("referrals: customer page data lists friends, their orders and revenue (cancelled excluded, refunds subtracted)");

  // ---- reporting currency: always INR, no selector; the store's own currency is untouched
  const C = await import("../app/services/currency.server.js");
  const fresh = async () => await prisma.store.findUnique({ where: { id: store.id }, include: { settings: true } });
  const realFetch = globalThis.fetch;
  const rateService = (inr) => async () => ({ ok: true, json: async () => ({ result: "success", rates: { INR: inr } }) });
  assert.equal(C.REPORT_CURRENCY(), "INR");
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { fxRate: null, fxPair: null, fxRateAt: null } });
  globalThis.fetch = rateService(80);
  let fx = await C.getFx(await fresh());                                                   // the test store sells in USD
  assert.deepEqual([fx.rate, fx.converted, fx.from, fx.to], [80, true, "USD", "INR"]);
  const inUsd = await loadAnalytics(await fresh(), 30);
  const inInr = await loadAnalytics(await fresh(), 30, fx);
  assert.equal(inInr.currency, "INR");
  assert.equal(Math.round(inInr.orders.revenue), Math.round(inUsd.orders.revenue * 80));
  assert.equal(Math.round(inInr.referralRevenue.revenue), 50 * 80);
  assert.equal(inInr.orders.count, inUsd.orders.count);                                      // counts and points never convert
  assert.equal(inInr.points.issued, inUsd.points.issued);
  ok("reporting currency: a USD store is shown in INR by default; money converts, counts and points don't");

  globalThis.fetch = async () => { throw new Error("must not be called: the rate is fresh"); };
  assert.equal((await C.getFx(await fresh())).rate, 80);                                    // a fresh rate isn't refetched
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { fxRateAt: new Date(Date.now() - 3 * 86400000) } });
  const stale = await C.getFx(await fresh());                                               // rate service down → last saved rate, flagged
  assert.deepEqual([stale.rate, stale.stale, stale.converted], [80, true, true]);
  globalThis.fetch = rateService(95);
  assert.equal((await C.getFx(await fresh())).rate, 95);                                    // old rate refreshes automatically
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { fxRate: null, fxPair: null, fxRateAt: null } });
  globalThis.fetch = async () => { throw new Error("offline"); };
  const none = await C.getFx(await fresh());                                                // no rate and no service → stays in store currency
  assert.equal(none.converted, false);
  assert.match(none.error, /Couldn't get an exchange rate/);
  globalThis.fetch = realFetch;
  const inrStore = { id: store.id, currency: "INR", settings: (await fresh()).settings };
  assert.deepEqual([(await C.getFx(inrStore)).rate, (await C.getFx(inrStore)).converted], [1, false]);   // an INR store: nothing to convert
  ok("reporting currency: fresh rate not refetched, stale rate used if the service is down, INR stores untouched");
  // ---- per-block styling in the widget
  const WD = await import("../app/lib/widget/defaults.js");
  const WR = await import("../app/lib/widget/render.js");
  const dirty = WD.normalizeStyle({ bg: "red; background:url(//evil)", text: "#112233", accent: "#ff0000", radius: 999, pad: -5, fontSize: "18", weight: "900", align: "justify", hideOn: "tablet", bogus: "x" });
  assert.deepEqual(dirty, { text: "#112233", accent: "#ff0000", radius: 40, pad: 0, fontSize: 18 });   // bad colours/values dropped, numbers clamped
  const styled = WD.normalizeConfig({ blocks: [
    { type: "balance", style: { accent: "#e11d48", cardBg: "#fff1f2", radius: 6, pad: 8, hideOn: "mobile", align: "left" } },
    { type: "header", style: { bg: "#111827", text: "#ffffff" } },
  ] });
  assert.deepEqual(styled.blocks[0].style.accent, "#e11d48");
  const styledHtml = WR.renderBlocks(styled, { loggedIn: true, customer: { points: 5 } });
  assert.ok(styledHtml.includes("--p:#e11d48") && styledHtml.includes("--sf:#fff1f2") && styledHtml.includes("--r:6px") && styledHtml.includes("lw-hide-mobile"));
  assert.ok(styledHtml.includes("--hbg:#111827") && styledHtml.includes("--hfg:#ffffff"));            // header colours use their own variables
  assert.ok(!styledHtml.includes("evil"));
  assert.ok(WR.widgetCss(WD.normalizeConfig({})).includes("var(--hbg,"));
  ok("widget blocks: each block's colours, radius, spacing and visibility are applied; unsafe values never reach the page");

  // ---- the My Rewards side drawer
  const cfg0 = WD.normalizeConfig({});
  assert.deepEqual([cfg0.account.tab, cfg0.account.label, cfg0.account.drawerWidth], [true, "My Rewards", 420]);
  assert.equal(WD.normalizeConfig({ account: { drawerWidth: 9999, label: "" } }).account.drawerWidth, 560);
  assert.ok(WR.DEFAULT_DRAWER_SHELL.includes("{{content}}") && WR.DEFAULT_DRAWER_SHELL.includes('data-action="toggle"'));
  assert.ok(WR.drawerCss({ account: { drawerWidth: 480 } }).includes("min(480px"));
  assert.ok(WR.widgetCss(cfg0).includes(".lw-is-drawer"));
  const codes = WR.renderBlocks(WD.normalizeConfig({ blocks: [{ type: "coupons" }] }), { loggedIn: true, coupons: [{ code: "LOY-1", rewardName: "R", status: "ACTIVE", expiresAt: "2026-12-01" }] });
  assert.ok(codes.includes('data-action="copy"') && !codes.includes('data-action="apply"') && !/checkout/i.test(codes));   // codes are copy-only
  ok("account drawer: default settings, shell, CSS; discount codes are copy-only");

  // ---- email designs and per-block styling
  for (const kind of Object.keys(E.EMAIL_KINDS)) {
    for (const id of Object.keys(E.EMAIL_PRESETS)) {
      const tpl = E.buildPreset(kind, id);
      const out = E.renderEmail(kind, tpl, E.EMAIL_KINDS[kind].sample);
      assert.ok(out.html.includes("<table") && !out.html.includes("{{") && out.subject.length > 0, `${kind}/${id}`);
      assert.deepEqual(E.missingRequired(kind, tpl, E.EMAIL_KINDS[kind].sample), []);             // the login code survives every design
    }
  }
  assert.ok(E.renderEmail("points_earned", E.defaultEmailTemplate("points_earned"), E.EMAIL_KINDS.points_earned.sample).html.includes("#f0708a")); // Claura-style blush is the default
  assert.deepEqual(E.normalizeEmailStyle({ bg: "red;x", box: "#abc", size: 999, padTop: "12", weight: "900", italic: "yes", upper: true }), { box: "#abc", size: 48, padTop: 12, upper: true });
  const styledMail = E.renderEmail("redeemed", {
    blocks: [
      { type: "heading", settings: { text: "Hi" }, style: { bg: "#ffeeaa", padTop: 40, size: 31, color: "#112233", weight: "800", lineHeight: "2", align: "center", italic: true } },
      { type: "text", settings: { text: "Visit [our shop]({{shop_url}}) or [bad](javascript:alert(1)). **Bold**" }, style: { box: "#eeeeee", radius: 12, boxPad: 20 } },
      { type: "image", settings: { url: "https://cdn.example.com/a.png", link: "{{shop_url}}", width: 300 }, style: { radius: 16 } },
      { type: "image", settings: { url: "http://insecure.example.com/a.png" } },
      { type: "button", settings: { label: "Go", url: "{{shop_url}}", fullWidth: true }, style: { box: "#0000ff", radius: 999, color: "#ffffff" } },
      { type: "links", settings: { items: "Shop | {{shop_url}}\nHelp | mailto:help@example.com\nNowhere | javascript:alert(1)" } },
    ],
  }, E.EMAIL_KINDS.redeemed.sample);
  const h = styledMail.html;
  assert.ok(h.includes("background:#ffeeaa") && h.includes("padding:40px") && h.includes("font-size:31px") && h.includes("color:#112233") && h.includes("font-weight:800") && h.includes("line-height:2") && h.includes("text-align:center") && h.includes("font-style:italic"));
  assert.ok(h.includes('href="https://example.myshopify.com"') && h.includes(">our shop</a>") && !/href="javascript/i.test(h) && h.includes("<strong>Bold</strong>"));
  assert.ok(h.includes("background:#eeeeee") && h.includes("border-radius:12px") && h.includes("padding:20px"));
  assert.ok(h.includes('src="https://cdn.example.com/a.png"') && h.includes("border-radius:16px") && !h.includes("insecure.example.com"));   // https images only
  assert.ok(h.includes("background:#0000ff") && h.includes("border-radius:60px") && h.includes("display:block;text-align:center"));
  assert.ok(h.includes('href="mailto:help@example.com"') && h.includes(">Nowhere<") && !/href="javascript/i.test(h));
  ok("emails: six designs render for all four emails (login code intact); per-block colour, spacing, text, boxes, links and images work and stay safe");
  // ---- points-about-to-expire reminders
  const RM = await import("../app/services/reminders.server.js");
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { expiryDays: 30, expiryReminderDays: 7 } });
  const ivy = await upsertCustomer(store.id, { shopifyCustomerId: "31", email: "ivy@example.invalid", emailVerified: true });
  const jon = await upsertCustomer(store.id, { shopifyCustomerId: "32", email: "jon@example.invalid", emailVerified: true });
  const inDays = (d) => new Date(Date.now() + d * 86400000);
  const lot = (c, pts, d, key) => postTransaction({ storeId: store.id, customerId: c.id, type: "ADJUST", points: pts, source: "manual", idempotencyKey: key, expiresAt: inDays(d) });
  await lot(ivy, 100, 3, "rm-a");     // expires in 3 days  → warn
  await lot(ivy, 50, 5, "rm-b");      // also within the window → summed into one reminder
  await lot(ivy, 200, 20, "rm-c");    // too far away → not yet
  await lot(jon, 70, 40, "rm-d");     // nowhere near
  const spent = await lot(jon, 30, 2, "rm-e");
  await prisma.pointsTransaction.update({ where: { id: spent.transaction.id }, data: { remaining: 0 } }); // already spent → nothing left to expire
  const batches = await RM.expiringBatches(store.id, 7);
  const mine = batches.filter((b) => [ivy.id, jon.id].includes(b.customerId));
  assert.equal(mine.length, 1);                                                             // only Ivy
  assert.deepEqual([mine[0].customerId, mine[0].points], [ivy.id, 150]);                   // 100 + 50, one entry
  assert.equal(mine[0].date, inDays(3).toISOString().slice(0, 10));                        // dated by the earliest batch
  const wider = (await RM.expiringBatches(store.id, 30)).find((b) => b.customerId === ivy.id);
  assert.equal(wider.points, 375);                                                          // a longer window adds the 20-day lot (200) and her 30-day welcome bonus (25)
  assert.equal(wider.firstLotId, mine[0].firstLotId);                                       // same key → the same email isn't sent twice
  await postTransaction({ storeId: store.id, customerId: ivy.id, type: "ADJUST", points: 1, idempotencyKey: "rm-f", source: "manual", expiresAt: inDays(-1) });
  assert.ok(!(await RM.expiringBatches(store.id, 7)).some((b) => b.points === 1));          // already-expired points belong to the expiry job
  const sentBefore = await prisma.notification.count({ where: { storeId: store.id } });
  await RM.sendExpiryReminders();                                                            // this store has emails switched off
  assert.equal(await prisma.notification.count({ where: { storeId: store.id } }), sentBefore);
  ok("expiry reminders: customers with points expiring in the warning window are found once, summed, and dated by their earliest batch");
  // ---- a new store gets starter rewards in ITS currency
  const shop2 = `cur-${Date.now()}.myshopify.com`;
  const { ensureStore } = await import("../app/services/store.server.js");
  const inrAdmin = { graphql: async () => ({ json: async () => ({ data: { shop: { name: "Rupee Shop", email: "o@x.invalid", currencyCode: "INR" } } }) }) };
  const s2 = await ensureStore({ shop: shop2, scope: "read_products" }, inrAdmin);
  try {
    assert.equal(s2.currency, "INR");
    const rw = await prisma.reward.findMany({ where: { storeId: s2.id }, orderBy: { pointsCost: "asc" } });
    const fixed = rw.find((r) => r.type === "FIXED_AMOUNT");
    assert.ok(/₹/.test(fixed.name) && !/\$/.test(fixed.name), fixed.name);
    assert.equal(Number(fixed.value), 100);
    assert.equal(fixed.pointsCost, 10000);                                               // same 100 points = 1 unit ratio as USD
    assert.equal(Number(rw.find((r) => r.type === "CUSTOM_AMOUNT").value), 1);
  } finally {
    await deleteStore(shop2);
  }
  ok("new INR store: starter reward is named and sized in rupees, not dollars");

  // ---- new customer accounts: Shopify's session token identifies the shop and customer
  const { verifySessionToken, TokenError } = await import("../app/services/customeraccount.server.js");
  const { createHmac } = await import("node:crypto");
  const creds = { secret: "test-secret", apiKey: "test-key" };
  const sign = (payload, secret = creds.secret, alg = "HS256") => {
    const p = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${p({ alg, typ: "JWT" })}.${p(payload)}`;
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = { dest: "https://tok-shop.myshopify.com", aud: "test-key", sub: "gid://shopify/Customer/777", exp: nowSec + 300, nbf: nowSec - 5 };
  assert.deepEqual(verifySessionToken(`Bearer ${sign(claims)}`, creds), { shop: "tok-shop.myshopify.com", customerId: "777" });
  assert.equal(verifySessionToken(sign({ ...claims, sub: "guest" }), creds).customerId, null);        // signed in as nobody → no account
  const bad = (t, why) => assert.throws(() => verifySessionToken(t, creds), TokenError, why);
  bad(sign(claims, "other-secret"), "wrong signature");
  bad(sign({ ...claims, exp: nowSec - 60 }), "expired");
  bad(sign({ ...claims, aud: "someone-elses-app" }), "other app");
  bad(sign({ ...claims, dest: "https://evil.example.com" }), "not a shop");
  bad(sign(claims, creds.secret, "none"), "alg must be HS256");
  bad("", "no token");
  bad("a.b.c", "garbage");
  ok("customer accounts: session token accepted only when signed by us, for this app, unexpired, with a real shop");

  // ---- importing customers and balances from a CSV / Shopify
  const IMP = await import("../app/services/import.server.js");
  const csvText = '﻿First Name,Last Name,E-mail,Points Balance\r\nAsha,"Rao, Jr",ASHA@Import.test,"1,200"\r\nRahul,Mehta,rahul@import.test,\r\nbad-address,X,not-an-email,50\r\nDup,Row,asha@import.test,5\r\nNeg,Ative,neg@import.test,-3\r\n';
  const parsed = IMP.readImportRows(csvText);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[0], { line: 2, email: "asha@import.test", firstName: "Asha", lastName: "Rao, Jr", points: 1200 });
  assert.equal(parsed.problems.length, 3);                                                   // bad email, duplicate, negative points
  assert.ok(IMP.readImportRows("name,points\nA,1").error.includes("email"));
  const imp1 = await IMP.importCustomers(store, csvText);
  assert.deepEqual([imp1.created, imp1.matched, imp1.pointsAdded, imp1.withPoints], [3, 0, 1200, 1]);
  const asha = await prisma.customer.findUnique({ where: { storeId_email: { storeId: store.id, email: "asha@import.test" } } });
  assert.deepEqual([asha.pointsBalance, asha.lifetimePoints, asha.emailVerified, asha.shopifyCustomerId], [1200, 1200, false, null]);
  const imp2 = await IMP.importCustomers(store, csvText);                                    // same file again: nothing doubles
  assert.deepEqual([imp2.created, imp2.matched, imp2.pointsAdded, imp2.alreadyImported], [0, 3, 0, 1]);
  assert.equal((await prisma.customer.findUnique({ where: { id: asha.id } })).pointsBalance, 1200);
  // an imported account becomes the Shopify customer once Shopify confirms the same email
  const stranger = await upsertCustomer(store.id, { shopifyCustomerId: "9100", email: "rahul@import.test", emailVerified: false });
  assert.notEqual(stranger.id, (await prisma.customer.findUnique({ where: { storeId_email: { storeId: store.id, email: "rahul@import.test" } } })).id);  // an unverified Shopify email never takes over an import
  const adoptedImport = await upsertCustomer(store.id, { shopifyCustomerId: "9101", email: "asha@import.test", emailVerified: true });
  assert.deepEqual([adoptedImport.id === asha.id, adoptedImport.pointsBalance, adoptedImport.emailVerified, adoptedImport.shopifyCustomerId], [true, 1200, true, "9101"]);
  const shopifyAdmin = (pages) => {
    let i = 0;
    return { graphql: async () => ({ json: async () => ({ data: { customers: { nodes: pages[i], pageInfo: { hasNextPage: (i += 1) < pages.length, endCursor: `c${i}` } } } }) }) };
  };
  const n1 = (id, email) => ({ id: `gid://shopify/Customer/${id}`, email, firstName: "S", lastName: "H", phone: null, verifiedEmail: true });
  const si = await IMP.importShopifyCustomers(store, shopifyAdmin([[n1(8001, "s1@import.test"), n1(8002, "s2@import.test")], [n1(8003, "s3@import.test")]]));
  assert.deepEqual([si.seen, si.created, si.existing, si.next], [3, 3, 0, null]);
  const s1 = await prisma.customer.findFirst({ where: { storeId: store.id, shopifyCustomerId: "8001" } });
  assert.equal(s1.pointsBalance, 0);                                                         // no welcome bonus for imports
  const si2 = await IMP.importShopifyCustomers(store, shopifyAdmin([[n1(8001, "s1@import.test")]]));
  assert.deepEqual([si2.created, si2.existing], [0, 1]);
  ok("import: CSV (quotes, BOM, aliases, bad rows) and Shopify customers create accounts + balances once, no welcome bonus, imports stay unverified");

  // ---- more email designs and exact spacing
  const EM = await import("../app/lib/email/templates.js");
  const presetIds = Object.keys(EM.EMAIL_PRESETS);
  assert.ok(presetIds.length >= 15);
  for (const id of presetIds) {
    for (const kind of Object.keys(EM.EMAIL_KINDS)) {
      const out = EM.renderEmail(kind, EM.buildPreset(kind, id), { store: "S", points: 5, balance: 9, first_name: "A", code: "CODE1", reward_name: "R", expires_at: "d", reason: "r", shop_url: "https://x.test" });
      assert.ok(out.html.includes("<table") && !out.html.includes("undefined"), `${id}/${kind}`);
      if (kind === "otp") assert.ok(out.html.includes("CODE1"), `${id} keeps the login code`);
    }
  }
  const sp = EM.buildPreset("redeemed", "classic");
  sp.blocks.forEach((b) => (b.style = {}));
  sp.theme.padX = 7;
  sp.theme.rowGap = 3;
  const spHtml = EM.renderEmail("redeemed", sp, { store: "S", code: "C", first_name: "A", reward_name: "R", shop_url: "https://x.test" }).html;
  assert.ok(spHtml.includes("padding:3px 7px 3px;"));                                     // theme sets every row's spacing exactly
  sp.blocks[2].style = { padTop: 40, padX: 12 };
  assert.ok(EM.renderEmail("redeemed", sp, { store: "S", code: "C", first_name: "A", reward_name: "R", shop_url: "https://x.test" }).html.includes("padding:40px 12px 3px"));  // a block's own spacing wins
  assert.equal(EM.normalizeEmailTemplate("redeemed", { theme: { padX: 999, rowGap: "x" } }).theme.padX, 100);
  assert.equal(EM.normalizeEmailTemplate("redeemed", { theme: { rowGap: "x" } }).theme.rowGap, "");
  ok("emails: 15 designs render for all four emails; theme-wide exact spacing applies, per-block spacing overrides it, bad values are clamped");

  // ---- analytics
  await postTransaction({ storeId: store.id, customerId: dana.id, type: "ADJUST", points: 10, source: "manual", idempotencyKey: "an1" });
  const a = await loadAnalytics(store, 30);
  assert.ok(a.members.total >= 6 && a.members.new >= 6);
  assert.ok(a.points.issued > 0);
  assert.ok(a.series.length === 30 && a.series.some((s) => s.earned > 0));
  assert.ok(a.sources.some((s) => s.label === "Referrals") && a.sources.some((s) => s.label === "Reviews"));
  assert.equal(a.reviewsRewarded, 2);
  assert.equal((await loadAnalytics(store, null)).series.length, 90);

  // date ranges (fixed "now" so the expectations are exact)
  const { resolveRange } = await import("../app/lib/analytics-ranges.js");
  const NOW = new Date("2026-10-31T12:00:00.000Z");
  const day = (d) => d && d.toISOString();
  const rr = (o) => resolveRange(o, NOW);
  assert.equal(day(rr({ range: "today" }).since), "2026-10-31T00:00:00.000Z");
  assert.equal(day(rr({ range: "yesterday" }).since), "2026-10-30T00:00:00.000Z");
  assert.equal(day(rr({ range: "yesterday" }).until), "2026-10-30T23:59:59.999Z");
  assert.equal(day(rr({ range: "7d" }).since), "2026-10-25T00:00:00.000Z");
  assert.equal(day(rr({ range: "this_month" }).since), "2026-10-01T00:00:00.000Z");
  assert.equal(day(rr({ range: "last_month" }).since), "2026-09-01T00:00:00.000Z");
  assert.equal(day(rr({ range: "last_month" }).until), "2026-09-30T23:59:59.999Z");
  assert.equal(day(rr({ range: "this_year" }).since), "2026-01-01T00:00:00.000Z");
  assert.equal(rr({ range: "all" }).since, null);
  assert.equal(rr({ range: "7" }).key, "7d");                                  // old links still work
  assert.equal(rr({ range: "bogus" }).key, "30d");
  const cust = rr({ range: "custom", from: "2026-10-10", to: "2026-10-20" });
  assert.equal(day(cust.since), "2026-10-10T00:00:00.000Z");
  assert.equal(day(cust.until), "2026-10-20T23:59:59.999Z");                   // the "to" day is included in full
  assert.equal(day(rr({ range: "custom", from: "2026-10-20", to: "2026-10-10" }).since), "2026-10-10T00:00:00.000Z"); // swapped dates are fixed
  assert.equal(rr({ range: "custom", from: "nope", to: "2026-10-10" }).key, "30d"); // bad dates fall back
  ok("analytics ranges: presets, custom range, swapped/invalid dates and old links all resolve correctly");

  const past = await loadAnalytics(store, resolveRange({ range: "custom", from: "2020-01-01", to: "2020-01-10" }));
  assert.equal(past.members.new, 0);
  assert.equal(past.points.issued, 0);
  assert.equal(past.orders.count, 0);
  assert.equal(past.series.length, 10);
  assert.equal(past.bucket, "day");
  assert.ok(past.members.total >= 6);                                           // totals aren't date-limited
  const todayData = await loadAnalytics(store, resolveRange({ range: "today" }));
  assert.ok(todayData.members.new >= 6 && todayData.points.issued > 0);        // the test customers were created today
  const yesterdayData = await loadAnalytics(store, resolveRange({ range: "yesterday" }));
  assert.equal(yesterdayData.members.new, 0);
  assert.equal(yesterdayData.points.issued, 0);
  const longRange = await loadAnalytics(store, resolveRange({ range: "custom", from: "2026-01-01", to: new Date().toISOString().slice(0, 10) }));
  assert.equal(longRange.bucket, "week");
  assert.ok(longRange.series.length < 60 && longRange.series.some((s) => s.earned > 0));
  ok("analytics queries respect the start and end date; long ranges switch to weekly bars");
  ok("analytics: members, points by source, referrals/reviews and daily series all compute");
} finally {
  const counts = () => Promise.all([prisma.customer.count({ where: { storeId: store.id } }), prisma.referral.count({ where: { storeId: store.id } }), prisma.integration.count({ where: { storeId: store.id } }), prisma.otpChallenge.count({ where: { storeId: store.id } }), prisma.loyaltySession.count({ where: { storeId: store.id } }), prisma.emailTemplate.count({ where: { storeId: store.id } })]);
  console.log("  before delete (customers, referrals, integrations, otp, sessions, emailTemplates):", await counts());
  await deleteStore(shop);
  const after = await counts();
  assert.deepEqual(after, [0, 0, 0, 0, 0, 0]);
  console.log("  âœ“ deleting the store removed all of it:", after);
  await prisma.$disconnect();
}
console.log("\nAll feature checks passed.");
process.exit(0);
