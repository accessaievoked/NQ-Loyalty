// End-to-end check of the loyalty logic against the real database (no Shopify, no email).
// Creates a throwaway store, exercises earn / hold / refund / redeem / expiry, then deletes
// the store to prove the cascade. Run: node scripts/smoke-test.mjs
import "dotenv/config";
import assert from "node:assert/strict";
import prisma from "../app/db.server.js";
import { postTransaction, expireDuePoints, InsufficientPointsError } from "../app/services/ledger.server.js";
import { handleOrderEvent, handleRefund, releaseDueAwards, handleFulfillmentEvent } from "../app/services/orders.server.js";
import { upsertCustomer } from "../app/services/customers.server.js";
import { redeemReward, RedeemError } from "../app/services/redeem.server.js";
import { deleteStore } from "../app/services/store.server.js";

const shop = `smoke-${Date.now()}.myshopify.com`;
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

const store = await prisma.store.create({
  data: {
    shop,
    currency: "USD",
    settings: { create: { earnTrigger: "PAID", holdDays: 0, expiryDays: 30 } },
    earnRules: { create: [{ name: "per $", type: "PURCHASE_PER_CURRENCY", value: 2 }, { name: "welcome", type: "SIGNUP", value: 50 }] },
    rewards: { create: [{ name: "$5 off", type: "FIXED_AMOUNT", value: 5, pointsCost: 100 }] },
  },
  include: { settings: true },
});

try {
  const order = (id, extra = {}) => ({
    id, name: `#${id}`, email: "smoke@example.invalid", currency: "USD",
    subtotal_price: "50.00", processed_at: new Date().toISOString(),
    customer: { id: 777, email: null, first_name: "Smoke", last_name: "Test" }, discount_codes: [], ...extra,
  });
  const balance = async (cid) => (await prisma.customer.findUnique({ where: { id: cid } })).pointsBalance;

  // signup bonus once
  const c = await upsertCustomer(store.id, { shopifyCustomerId: "777", firstName: "Smoke" });
  await upsertCustomer(store.id, { shopifyCustomerId: "777", firstName: "Smoke" });
  assert.equal(await balance(c.id), 50);
  ok("signup bonus granted exactly once");

  // earn with 0-day hold: credited immediately; webhook replay is a no-op
  await handleOrderEvent(store, "orders/paid", order(1001));
  await handleOrderEvent(store, "orders/paid", order(1001));
  assert.equal(await balance(c.id), 150);
  assert.equal(await prisma.pointsAward.count({ where: { storeId: store.id } }), 1);
  ok("paid order credited 100 pts immediately; duplicate webhook ignored");

  // ledger idempotency + insufficient funds
  const a = await postTransaction({ storeId: store.id, customerId: c.id, type: "ADJUST", points: 10, idempotencyKey: "k1" });
  const b = await postTransaction({ storeId: store.id, customerId: c.id, type: "ADJUST", points: 10, idempotencyKey: "k1" });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(await balance(c.id), 160);
  await assert.rejects(
    postTransaction({ storeId: store.id, customerId: c.id, type: "REDEEM", points: -9999, idempotencyKey: "k2" }),
    InsufficientPointsError,
  );
  ok("ledger is idempotent and refuses overdrafts");

  // concurrent debits can't overspend (160 available, 3 x 100)
  const results = await Promise.allSettled(
    [1, 2, 3].map((i) => postTransaction({ storeId: store.id, customerId: c.id, type: "ADJUST", points: -100, idempotencyKey: `race${i}` })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await balance(c.id), 60);
  ok("concurrent debits serialised: only one of three 100-pt debits succeeded");

  // partial refund reverses proportionally, replay is a no-op
  await handleRefund(store, { id: 5001, order_id: 1001, refund_line_items: [{ subtotal: "25.00" }] });
  await handleRefund(store, { id: 5001, order_id: 1001, refund_line_items: [{ subtotal: "25.00" }] });
  assert.equal(await balance(c.id), 10); // 100 earned, half (50) reversed: 60 - 50
  ok("half refund reversed 50 pts once");

  // cancellation reverses only the remainder
  await handleOrderEvent(store, "orders/cancelled", order(1001, { cancelled_at: new Date().toISOString() }));
  assert.equal(await balance(c.id), -40); // remaining 50 reversed; may dip below zero
  ok("cancel reversed the remaining 50 pts (balance may go negative)");

  // hold period: award stays pending, then released by the sweeper
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { holdDays: 7 } });
  const fresh = await prisma.store.findUnique({ where: { id: store.id }, include: { settings: true } });
  await handleOrderEvent(fresh, "orders/paid", order(1002, { subtotal_price: "20.00" }));
  let award = await prisma.pointsAward.findFirst({ where: { order: { shopifyOrderId: "1002" } } });
  assert.equal(award.status, "PENDING");
  const before = await balance(c.id);
  assert.equal(await releaseDueAwards(), 0);
  await prisma.pointsAward.update({ where: { id: award.id }, data: { releaseAt: new Date(Date.now() - 1000) } });
  assert.equal(await releaseDueAwards(), 1);
  assert.equal(await balance(c.id), before + 40);
  ok("7-day hold: pending until due, then the sweeper credited 40 pts");

  // trigger = FULFILLED ignores paid-only orders until fulfilled
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { holdDays: 0, earnTrigger: "FULFILLED" } });
  const f2 = await prisma.store.findUnique({ where: { id: store.id }, include: { settings: true } });
  await handleOrderEvent(f2, "orders/paid", order(1003, { subtotal_price: "10.00" }));
  assert.equal(await prisma.pointsAward.count({ where: { order: { shopifyOrderId: "1003" } } }), 0);
  await handleOrderEvent(f2, "orders/fulfilled", order(1003, { subtotal_price: "10.00", updated_at: new Date().toISOString() }));
  assert.equal(await prisma.pointsAward.count({ where: { order: { shopifyOrderId: "1003" } } }), 1);
  ok("FULFILLED trigger: no points when paid, credited once fulfilled");

  // trigger = DELIVERED via fulfillment event
  await prisma.storeSettings.update({ where: { storeId: store.id }, data: { earnTrigger: "DELIVERED" } });
  const f3 = await prisma.store.findUnique({ where: { id: store.id }, include: { settings: true } });
  await handleOrderEvent(f3, "orders/paid", order(1004, { subtotal_price: "10.00" }));
  assert.equal(await prisma.pointsAward.count({ where: { order: { shopifyOrderId: "1004" } } }), 0);
  await handleFulfillmentEvent(f3, { order_id: 1004, status: "delivered" });
  assert.equal(await prisma.pointsAward.count({ where: { order: { shopifyOrderId: "1004" } } }), 1);
  ok("DELIVERED trigger: credited on delivery event");

  // redemption: debit, discount created via (fake) admin, replay deduped
  await postTransaction({ storeId: store.id, customerId: c.id, type: "ADJUST", points: 500, idempotencyKey: "topup" });
  const reward = await prisma.reward.findFirst({ where: { storeId: store.id } });
  let calls = 0;
  const admin = { graphql: async () => { calls++; return { json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" }, userErrors: [] } } }) }; } };
  const start = await balance(c.id);
  const r1 = await redeemReward({ store: f3, admin, customerId: c.id, rewardId: reward.id, requestId: "req-1" });
  const r2 = await redeemReward({ store: f3, admin, customerId: c.id, rewardId: reward.id, requestId: "req-1" });
  assert.equal(r1.id, r2.id);
  assert.equal(calls, 1);
  assert.equal(await balance(c.id), start - 100);
  assert.equal(r1.status, "ACTIVE");
  ok("redeem debited 100 pts once, created one Shopify discount, replay returned same code");

  // Shopify failure refunds the points
  const failing = { graphql: async () => ({ json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "boom" }] } } }) }) };
  const mid = await balance(c.id);
  await assert.rejects(redeemReward({ store: f3, admin: failing, customerId: c.id, rewardId: reward.id, requestId: "req-2" }), RedeemError);
  assert.equal(await balance(c.id), mid);
  ok("Shopify failure refunded the points");

  // custom-amount reward (Flits-style): 100 points = $1, min 100, max 500
  const custom = await prisma.reward.create({
    data: { storeId: store.id, name: "Use points", type: "CUSTOM_AMOUNT", value: 1, pointsCost: 100, minPoints: 100, maxPoints: 500 },
  });
  let sent;
  const capture = { graphql: async (_q, { variables }) => { sent = variables.input; return { json: async () => ({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/2" }, userErrors: [] } } }) }; } };
  const tryRedeem = (points, requestId) => redeemReward({ store: f3, admin: capture, customerId: c.id, rewardId: custom.id, requestId, points });
  const bal0 = await balance(c.id);
  for (const [pts, why] of [[350, "not a multiple of the step"], [0, "zero"], [600, "above the max"], [-100, "negative"], [undefined, "missing"]]) {
    await assert.rejects(tryRedeem(pts, `bad-${pts}`), RedeemError, why);
  }
  assert.equal(await balance(c.id), bal0);
  const big = await prisma.customer.update({ where: { id: c.id }, data: { pointsBalance: 50 } });
  await assert.rejects(tryRedeem(100, "poor"), RedeemError); // balance below spend
  await prisma.customer.update({ where: { id: big.id }, data: { pointsBalance: bal0 } });
  const r3 = await tryRedeem(300, "custom-1");
  assert.equal(r3.points, 300);
  assert.equal(sent.customerGets.value.discountAmount.amount, "3.00");
  assert.equal(sent.usageLimit, 1);
  assert.deepEqual(sent.customerSelection.customers.add, ["gid://shopify/Customer/777"]);
  assert.equal(await balance(c.id), bal0 - 300);
  await tryRedeem(300, "custom-1");
  assert.equal(await balance(c.id), bal0 - 300);
  ok("custom amount: bad inputs rejected, 300 pts → $3.00 single-use code for that customer, replay deduped");

  // expiry (FIFO lots)
  const lot = await postTransaction({ storeId: store.id, customerId: c.id, type: "ADJUST", points: 30, idempotencyKey: "lot", expiresAt: new Date(Date.now() - 1000) });
  const withLot = await balance(c.id);
  assert.ok((await expireDuePoints()) >= 1);
  assert.equal(await balance(c.id), withLot - 30);
  assert.equal((await prisma.pointsTransaction.findUnique({ where: { id: lot.transaction.id } })).remaining, 0);
  ok("expired lot removed 30 pts");

  // ledger integrity: balance equals sum of rows, and last balanceAfter
  const sum = await prisma.pointsTransaction.aggregate({ where: { customerId: c.id }, _sum: { points: true } });
  assert.equal(sum._sum.points, await balance(c.id));
  ok("customer balance equals the sum of the ledger");
} finally {
  const counts = async () => (await Promise.all([
    prisma.customer.count({ where: { storeId: store.id } }),
    prisma.pointsTransaction.count({ where: { storeId: store.id } }),
    prisma.order.count({ where: { storeId: store.id } }),
    prisma.reward.count({ where: { storeId: store.id } }),
  ]));
  console.log("  before delete (customers, ledger, orders, rewards):", await counts());
  await deleteStore(shop);
  const after = await counts();
  console.log("  after delete:", after);
  assert.deepEqual(after, [0, 0, 0, 0]);
  console.log("  ✓ deleting the store removed everything under it");
  await prisma.$disconnect();
}
console.log("\nAll checks passed.");
process.exit(0);
