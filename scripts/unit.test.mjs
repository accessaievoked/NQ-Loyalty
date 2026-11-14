// Unit tests for the pure functions: no database, no network.   Run: npm run test:unit
// (The two end-to-end scripts, smoke-test.mjs and smoke-test-features.mjs, cover the database paths.)
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Set before the app modules load. The database URL is never connected to.
process.env.APP_ENCRYPTION_KEY ||= "unit-test-key";
process.env.DATABASE_URL ||= "postgresql://u:p@127.0.0.1:1/unit";

const { computePurchasePoints } = await import("../app/services/orders.server.js");
const { priceRedemption, RedeemError } = await import("../app/services/redeem.server.js");
const { phoneKey } = await import("../app/lib/phone.js");
const { verifySessionToken, TokenError } = await import("../app/services/customeraccount.server.js");
const { signRef, verifyRef } = await import("../app/lib/crypto.server.js");
const { otpHourlyBlocked } = await import("../app/services/identity.server.js");
const { callerIp } = await import("../app/services/fastcheckout.server.js");
const { normalizeBrand, shade } = await import("../app/lib/email/templates.js");
const { parseCsv, readImportRows } = await import("../app/services/import.server.js");

// ---- computePurchasePoints ----------------------------------------------------------------------
test("computePurchasePoints: per-currency rules floor, fixed rules respect the minimum, inactive rules are ignored", () => {
  const rules = [
    { active: true, type: "PURCHASE_PER_CURRENCY", value: 2, minOrderAmount: 0 },
    { active: true, type: "PURCHASE_FIXED", value: 10, minOrderAmount: 100 },
    { active: false, type: "PURCHASE_PER_CURRENCY", value: 100, minOrderAmount: 0 },
  ];
  assert.equal(computePurchasePoints(rules, 50), 100); // 50 × 2, fixed bonus not reached
  assert.equal(computePurchasePoints(rules, 150), 310); // 300 + 10
  assert.equal(computePurchasePoints(rules, 10.99), 21); // floor(21.98)
  assert.equal(computePurchasePoints(rules, 0), 0);
  assert.equal(computePurchasePoints([], 500), 0);
});

// ---- priceRedemption ----------------------------------------------------------------------------
test("priceRedemption: fixed and percentage rewards cost their fixed price", () => {
  assert.deepEqual(priceRedemption({ type: "FIXED_AMOUNT", pointsCost: 100, value: 5, name: "₹5 off" }), { points: 100, amount: 5, name: "₹5 off" });
  assert.equal(priceRedemption({ type: "PERCENTAGE", pointsCost: 200, value: 10, name: "10%" }).amount, null);
});

test("priceRedemption: custom amounts must be whole steps within min and max", () => {
  const r = { type: "CUSTOM_AMOUNT", pointsCost: 100, value: 1, minPoints: 200, maxPoints: 500, name: "Cashback" };
  assert.deepEqual(priceRedemption(r, 300), { points: 300, amount: 3, name: "Cashback (300 points)" });
  assert.throws(() => priceRedemption(r, 250), /multiple of 100/);
  assert.throws(() => priceRedemption(r, 100), /Minimum is 200/);
  assert.throws(() => priceRedemption(r, 600), /Maximum is 500/);
  assert.throws(() => priceRedemption(r, "abc"), RedeemError);
  assert.throws(() => priceRedemption(r, -300), RedeemError);
  assert.throws(() => priceRedemption(r), RedeemError);
});

// ---- phoneKey -----------------------------------------------------------------------------------
test("phoneKey: every way of writing a number gives the same last 10 digits", () => {
  for (const raw of ["+91 88006 37327", "08800637327", "8800637327", "+91-8800-637-327", "(880) 063-7327"]) assert.equal(phoneKey(raw), "8800637327");
  assert.equal(phoneKey("12345"), null);
  assert.equal(phoneKey(""), null);
  assert.equal(phoneKey(null), null);
});

// ---- verifySessionToken (customer accounts) -----------------------------------------------------
test("verifySessionToken: accepts only a token signed by us, for this app, unexpired, for a real shop", () => {
  const creds = { secret: "s3cret", apiKey: "app-key" };
  const now = Math.floor(Date.now() / 1000);
  const sign = (payload, secret = creds.secret, alg = "HS256") => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${enc({ alg, typ: "JWT" })}.${enc(payload)}`;
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  const claims = { dest: "https://shop.myshopify.com", aud: "app-key", sub: "gid://shopify/Customer/42", exp: now + 300, nbf: now - 5 };
  assert.deepEqual(verifySessionToken(`Bearer ${sign(claims)}`, creds), { shop: "shop.myshopify.com", customerId: "42" });
  assert.equal(verifySessionToken(sign({ ...claims, sub: "nobody" }), creds).customerId, null);
  for (const [why, token] of [
    ["wrong secret", sign(claims, "other")],
    ["expired", sign({ ...claims, exp: now - 60 })],
    ["other app", sign({ ...claims, aud: "someone-else" })],
    ["not a shop", sign({ ...claims, dest: "https://evil.example.com" })],
    ["alg none", sign(claims, creds.secret, "none")],
    ["empty", ""],
    ["garbage", "a.b.c"],
  ]) assert.throws(() => verifySessionToken(token, creds), TokenError, why);
});

// ---- signRef / verifyRef (checkout attribution) -------------------------------------------------
test("verifyRef: a reference only verifies for the store and customer it was signed for", () => {
  const ref = signRef("store1", "cust1");
  assert.equal(verifyRef("store1", ref), "cust1");
  assert.equal(verifyRef("store2", ref), null); // another store
  assert.equal(verifyRef("store1", ref.replace("cust1", "cust2")), null); // swapped customer
  assert.equal(verifyRef("store1", `${ref}x`), null); // tampered signature
  assert.equal(verifyRef("store1", ""), null);
  assert.equal(verifyRef("store1", null), null);
  assert.equal(verifyRef("store1", `${"a".repeat(80)}.sig`), null);
});

// ---- email-code cap -----------------------------------------------------------------------------
test("otpHourlyBlocked: past the cap only unknown emails are turned away", () => {
  assert.equal(otpHourlyBlocked(300, false), true);
  assert.equal(otpHourlyBlocked(300, true), false);
  assert.equal(otpHourlyBlocked(299, false), false);
});

// ---- callerIp (fast-checkout IP list) -----------------------------------------------------------
test("callerIp: reads only the configured trusted header; x-forwarded-for uses its last entry", () => {
  const req = (headers) => new Request("https://app.test/x", { headers });
  const saved = process.env.TRUSTED_IP_HEADER;
  try {
    delete process.env.TRUSTED_IP_HEADER;
    assert.equal(callerIp(req({ "x-forwarded-for": "1.1.1.1" })), null); // nothing trusted → no address
    process.env.TRUSTED_IP_HEADER = "x-forwarded-for";
    assert.equal(callerIp(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 8.8.8.8" })), "8.8.8.8"); // the proxy's entry, not the caller's
    process.env.TRUSTED_IP_HEADER = "fly-client-ip";
    assert.equal(callerIp(req({ "fly-client-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "2.2.2.2" })), "9.9.9.9");
    assert.equal(callerIp(req({ "x-forwarded-for": "1.1.1.1" })), null);
  } finally {
    if (saved === undefined) delete process.env.TRUSTED_IP_HEADER;
    else process.env.TRUSTED_IP_HEADER = saved;
  }
});

// ---- email brand --------------------------------------------------------------------------------
test("normalizeBrand: https logo only, hex colours only, radius clamped; shade mixes toward black or white", () => {
  const b = normalizeBrand({ logoUrl: "http://x.test/a.png", brandColor: "red", radius: 999, footerTitle: "Hi\nthere" });
  assert.deepEqual([b.logoUrl, b.brandColor, b.radius, b.footerTitle], ["", "", 48, "Hi there"]);
  assert.equal(normalizeBrand({ logoUrl: "https://x.test/a.png" }).logoUrl, "https://x.test/a.png");
  assert.equal(normalizeBrand({ radius: "" }).radius, "");
  assert.equal(shade("#000000", 0.5), "#808080");
  assert.equal(shade("#ffffff", -0.5), "#808080");
  assert.equal(shade("not a colour", 0.5), "not a colour");
});

// ---- CSV import ---------------------------------------------------------------------------------
test("parseCsv / readImportRows: quotes, BOM, CRLF, header aliases; bad, duplicate and negative rows are reported", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  const { rows, problems, error } = readImportRows("E-mail,First Name,Points Balance\nA@X.TEST,Asha,\"1,200\"\nbad,B,5\na@x.test,Dup,5\nc@x.test,Cee,-3\n");
  assert.equal(error, undefined);
  assert.deepEqual(rows.map((r) => [r.email, r.firstName, r.points]), [["a@x.test", "Asha", 1200], ["c@x.test", "Cee", 0]]);
  assert.equal(problems.length, 3);
  assert.match(readImportRows("name,points\nA,1").error, /email/);
});
