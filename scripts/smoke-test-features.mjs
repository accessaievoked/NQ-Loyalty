// Checks for OTP login, referrals, Judge.me, Shiprocket, analytics and encryption against the
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
import {
  authenticateIntegrationWebhook, classifyShipment, ensureIntegration, handleShiprocketWebhook, processReview,
} from "../app/services/integrations.server.js";
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

  // ---- Shiprocket
  assert.equal(classifyShipment("Delivered"), "delivered");
  assert.equal(classifyShipment("RTO Delivered"), "returned");
  assert.equal(classifyShipment("RTO Initiated"), "returned");
  assert.equal(classifyShipment("In Transit"), "shipped");
  assert.equal(classifyShipment("Out For Delivery"), "shipped");
  assert.equal(classifyShipment("Lost"), "returned");
  ok("Shiprocket statuses classified (RTO Delivered counts as a return, not a delivery)");

  const sr = await ensureIntegration(store.id, "SHIPROCKET");
  await prisma.integration.update({ where: { id: sr.id }, data: { enabled: true } });
  const req = (url, headers = {}) => new Request(url, { method: "POST", headers });
  const base = `https://x.test/integrations/shiprocket/${store.id}`;
  assert.ok((await authenticateIntegrationWebhook(req(`${base}?token=${sr.webhookToken}`), "SHIPROCKET", store.id)).integration);
  assert.ok((await authenticateIntegrationWebhook(req(base, { "x-api-key": sr.webhookToken }), "SHIPROCKET", store.id)).integration);
  assert.equal((await authenticateIntegrationWebhook(req(`${base}?token=wrong`), "SHIPROCKET", store.id)).status, 401);
  assert.equal((await authenticateIntegrationWebhook(req(base), "SHIPROCKET", store.id)).status, 401);
  assert.equal((await authenticateIntegrationWebhook(req(`${base}?token=${sr.webhookToken}`), "SHIPROCKET", "other-store")).status, 401);
  ok("Shiprocket webhook accepts the token (query or header) and rejects everything else");

  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { earnTrigger: "DELIVERED", holdDays: 0 } });
  await reload();
  const erin = await upsertCustomer(store.id, { shopifyCustomerId: "5", email: "erin@example.invalid", emailVerified: true });
  const e0 = await bal(erin.id);
  const paid = order(4001, "5", 40);
  await handleOrderEvent(store, "orders/paid", paid);
  await handleOrderEvent(store, "orders/fulfilled", { ...paid, updated_at: new Date().toISOString(), fulfillments: [{ tracking_number: "AWB123" }] });
  const o = await prisma.order.findFirst({ where: { storeId: store.id, shopifyOrderId: "4001" } });
  assert.deepEqual(o.trackingNumbers, ["AWB123"]);
  assert.equal(await bal(erin.id), e0); // not delivered yet
  assert.match(await handleShiprocketWebhook(sr, { awb: "AWB123", current_status: "In Transit" }), /status saved/);
  assert.equal(await bal(erin.id), e0);
  assert.match(await handleShiprocketWebhook(sr, { awb: "AWB123", current_status: "Delivered", current_timestamp: "2026-10-01 10:00:00" }), /delivered/);
  assert.equal(await bal(erin.id), e0 + 40);
  await handleShiprocketWebhook(sr, { awb: "AWB123", current_status: "Delivered" }); // duplicate ping
  assert.equal(await bal(erin.id), e0 + 40);
  const delivered = await prisma.order.findUnique({ where: { id: o.id } });
  assert.equal(delivered.deliveredAt.toISOString().slice(0, 10), "2026-10-01"); // first delivery time kept
  ok("DELIVERED trigger + Shiprocket: no points until delivered, matched by AWB, duplicate pings are harmless");

  assert.match(await handleShiprocketWebhook(sr, { awb: "AWB123", current_status: "RTO Delivered" }), /returned/);
  assert.equal(await bal(erin.id), e0);
  assert.match(await handleShiprocketWebhook(sr, { order_id: "9999999", current_status: "Delivered" }), /no matching order/);
  ok("a returned parcel (RTO) takes the points back; unknown orders are ignored safely");

  // hold window after delivery: points wait N days
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { holdDays: 7 } });
  await reload();
  const fay = await upsertCustomer(store.id, { shopifyCustomerId: "6", email: "fay@example.invalid", emailVerified: true });
  const p2 = order(4002, "6", 40);
  await handleOrderEvent(store, "orders/paid", p2);
  await handleOrderEvent(store, "orders/fulfilled", { ...p2, updated_at: new Date().toISOString(), fulfillments: [{ tracking_number: "AWB777" }] });
  await handleShiprocketWebhook(sr, { order_id: "4002", current_status: "Delivered" }); // matched by order number
  const award = await prisma.pointsAward.findFirst({ where: { customerId: fay.id } });
  assert.equal(award.status, "PENDING");
  assert.ok(award.releaseAt.getTime() > Date.now() + 6 * 86400000);
  assert.equal(await bal(fay.id), 25); // welcome bonus only
  ok("return window: points stay pending for 7 days after Shiprocket reports delivery");

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
  assert.ok(htmlOut.includes("LOY-ABC123") && htmlOut.includes('data-action="apply"'));   // active code: usable
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

  // ---- reporting currency
  const C = await import("../app/services/currency.server.js");
  const fresh = async () => (await prisma.store.findUnique({ where: { id: store.id }, include: { settings: true } }));
  let fx = await C.getFx(await fresh());
  assert.deepEqual([fx.rate, fx.converted, fx.to], [1, false, "USD"]);
  await C.setDisplayCurrency(await fresh(), "INR");
  await C.setManualRate(await fresh(), 80);
  fx = await C.getFx(await fresh());
  assert.deepEqual([fx.rate, fx.converted, fx.to, fx.manual], [80, true, "INR", true]);
  const inUsd = await loadAnalytics(await fresh(), 30);
  const inInr = await loadAnalytics(await fresh(), 30, fx);
  assert.equal(inInr.currency, "INR");
  assert.equal(Math.round(inInr.orders.revenue), Math.round(inUsd.orders.revenue * 80));
  assert.equal(Math.round(inInr.referralRevenue.revenue), 50 * 80);
  assert.equal(inInr.orders.count, inUsd.orders.count);                                  // counts and points never convert
  assert.equal(inInr.points.issued, inUsd.points.issued);
  await assert.rejects(C.setManualRate(await fresh(), -5), /above 0/);
  await C.setDisplayCurrency(await fresh(), "XXX");                                       // unsupported → back to store currency
  assert.equal((await C.getFx(await fresh())).converted, false);
  ok("reporting currency: money converts by the rate, counts/points don't, bad input and unsupported currencies are refused");

  const realFetch = globalThis.fetch;
  await C.setDisplayCurrency(await fresh(), "EUR");
  globalThis.fetch = async () => { throw new Error("offline"); };
  let noRate = await C.getFx(await fresh());
  assert.equal(noRate.converted, false);                                                  // no rate and no service → stays in store currency
  assert.match(noRate.error, /Couldn't get an exchange rate/);
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { fxRate: 0.9, fxPair: "USD>EUR", fxRateAt: new Date(Date.now() - 3 * 86400000), fxManual: false } });
  const stale = await C.getFx(await fresh());
  assert.deepEqual([stale.rate, stale.stale, stale.converted], [0.9, true, true]);      // service down → last saved rate, flagged
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: "success", rates: { EUR: 0.95 } }) });
  const live = await C.getFx(await fresh());
  assert.deepEqual([live.rate, live.stale], [0.95, false]);                               // old rate refreshes automatically
  assert.equal(Number((await fresh()).settings.fxRate), 0.95);
  globalThis.fetch = async () => { throw new Error("must not be called: rate is fresh"); };
  assert.equal((await C.getFx(await fresh())).rate, 0.95);                                // a fresh rate isn't refetched
  globalThis.fetch = realFetch;
  await C.setDisplayCurrency(await fresh(), null);
  ok("reporting currency: stale rate used if the service is down, refreshed when old, not refetched when fresh");

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
