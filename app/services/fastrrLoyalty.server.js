import { randomUUID } from "node:crypto";
import prisma from "../db.server.js";
import { postTransaction, InsufficientPointsError, expiryDate } from "./ledger.server.js";
import { findCustomerByContact } from "./fastcheckout.server.js";

// Shiprocket Checkout / fastrr's own "Loyalty Points Manager" contract (their Postman doc, not the
// guessed lookup/redeem one above): their checkout calls us directly as it runs, keyed by the
// shopper's mobile number and *their* order id (not ours — we never see a Shopify order here).
//
//   POST …/loyalty/points   { mobile_number, cart_value }                      → balance + how much of it this cart can use
//   POST …/loyalty/block    { mobile_number, transactional_points, order_id }  → debits points, quotes the discount value
//   POST …/loyalty/unblock  { order_id }                                      → releases a block that never became an order
//   POST …/order-webhook    { order_id / platform_order_id, status, … }        → CONFIRMED on "SUCCESS", released otherwise
//
// Block debits the ledger immediately (so the balance can't be double-spent across two carts); the
// order webhook (or an explicit unblock) is what finalises or reverses that debit.

/** The single reward used to price Shiprocket's points-as-discount. Flits-style stores have exactly
 * one "customer picks points" (CUSTOM_AMOUNT) reward — that is the one that has a continuous
 * points→currency rate, which is what Shiprocket's contract needs (its `redemptionFactor`). */
async function pickLoyaltyReward(storeId) {
  return prisma.reward.findFirst({ where: { storeId, type: "CUSTOM_AMOUNT", active: true }, orderBy: { createdAt: "asc" } });
}

// Cart-value limits (see Reward.cartRanges): if any are set, points can only be used on a cart that
// falls in one of the ranges, up to that range's limit (a share of the cart, or a fixed number of points).
function rangeLimit(reward, cartValue, step, unitValue) {
  const ranges = Array.isArray(reward.cartRanges) ? reward.cartRanges : [];
  if (!ranges.length) return Infinity;
  const cart = Number(cartValue) || 0;
  const hit = ranges.find((r) => cart >= (Number(r.min) || 0) && (r.max == null || cart <= Number(r.max)));
  if (!hit) return 0;
  const limit = Number(hit.limit) || 0;
  if (hit.mode === "POINTS") return limit;
  return Math.floor((cart * Math.min(limit, 100)) / 100 / unitValue) * step;
}

function applicablePoints(reward, balance, cartValue) {
  if (!reward) return 0;
  const step = reward.pointsCost;
  const unitValue = Number(reward.value) || 0;
  if (step <= 0 || unitValue <= 0) return 0;
  const byValue = unitValue > 0 ? Math.floor((Number(cartValue) || 0) / unitValue) * step : 0;
  const cap = Math.min(balance, reward.maxPoints || Infinity, byValue, rangeLimit(reward, cartValue, step, unitValue));
  const floored = Math.floor(cap / step) * step;
  const min = Math.max(step, reward.minPoints || 0);
  return floored >= min ? floored : 0;
}

/** POST …/loyalty/points — how many points this shopper has, and how many this cart can use. */
export async function fetchLoyaltyPoints(store, { mobile_number, cart_value }) {
  const customer = await findCustomerByContact(store.id, { phone: mobile_number });
  const balance = customer?.pointsBalance || 0;
  const reward = customer ? await pickLoyaltyReward(store.id) : null;
  return {
    mobile_number: String(mobile_number),
    available_points: balance,
    applicable_points: customer ? applicablePoints(reward, balance, cart_value) : 0,
  };
}

function blockResult(block, availablePoints) {
  return {
    status: true,
    available_points: availablePoints,
    message: "Valid Customer Id",
    debited_points: block.points,
    transaction_id: block.id,
    discount_value: Number(block.discountValue),
    additional_properties: { redemptionFactor: Number(block.redemptionFactor) },
  };
}

/** POST …/loyalty/block — debit points for one of Shiprocket's own orders. Idempotent on order_id:
 * a retry with the same order_id while still BLOCKED returns the same result rather than debiting twice. */
export async function blockPoints(store, { mobile_number, transactional_points, order_id }) {
  const orderId = String(order_id ?? "").trim();
  if (!orderId) return { status: false, message: "order_id is required" };
  const points = Math.floor(Number(transactional_points));
  if (!Number.isFinite(points) || points <= 0) return { status: false, message: "transactional_points must be a positive number" };

  const existing = await prisma.loyaltyPointsBlock.findUnique({ where: { storeId_orderId: { storeId: store.id, orderId } } });
  if (existing && existing.status !== "RELEASED") {
    const c = await prisma.customer.findUnique({ where: { id: existing.customerId }, select: { pointsBalance: true } });
    return blockResult(existing, c?.pointsBalance ?? 0);
  }

  const customer = await findCustomerByContact(store.id, { phone: mobile_number });
  if (!customer) return { status: false, message: "Customer not found" };
  const reward = await pickLoyaltyReward(store.id);
  if (!reward) return { status: false, message: "Points redemption is not configured for this store", available_points: customer.pointsBalance };

  const step = reward.pointsCost;
  if (points % step !== 0) return { status: false, message: `transactional_points must be a multiple of ${step}`, available_points: customer.pointsBalance };
  const min = Math.max(step, reward.minPoints || 0);
  if (points < min) return { status: false, message: `Minimum is ${min} points`, available_points: customer.pointsBalance };
  if (reward.maxPoints && points > reward.maxPoints) {
    return { status: false, message: `Maximum is ${reward.maxPoints} points per order`, available_points: customer.pointsBalance };
  }
  if (customer.pointsBalance < points) return { status: false, message: "Not enough points", available_points: customer.pointsBalance };

  const unitValue = Number(reward.value);
  const discountValue = Math.round((points / step) * unitValue * 100) / 100;
  const redemptionFactor = Math.round((unitValue / step) * 10000) / 10000;
  // Only reached once per actual debit: an in-progress block for this order_id already returned
  // above, so this never needs to be stable across retries.
  const idemKey = `fastrr-block:${store.id}:${orderId}:${randomUUID()}`;

  let block;
  try {
    const { transaction } = await postTransaction({
      storeId: store.id,
      customerId: customer.id,
      type: "REDEEM",
      source: "fastrr",
      points: -points,
      idempotencyKey: idemKey,
      note: `Shiprocket checkout order ${orderId}`,
    });
    const data = { customerId: customer.id, points, discountValue, redemptionFactor, status: "BLOCKED", transactionId: transaction.id };
    block = existing
      ? await prisma.loyaltyPointsBlock.update({ where: { id: existing.id }, data })
      : await prisma.loyaltyPointsBlock.create({ data: { storeId: store.id, orderId, ...data } });
  } catch (e) {
    if (e instanceof InsufficientPointsError) return { status: false, message: "Not enough points", available_points: customer.pointsBalance };
    throw e;
  }

  const fresh = await prisma.customer.findUnique({ where: { id: customer.id }, select: { pointsBalance: true } });
  return blockResult(block, fresh.pointsBalance);
}

/** Refund a BLOCKED hold. Safe to call more than once, and safe when nothing was ever blocked. */
export async function unblockPoints(store, { order_id }) {
  const orderId = String(order_id ?? "").trim();
  if (!orderId) return { status: "Failed", message: "order_id is required" };
  const block = await prisma.loyaltyPointsBlock.findUnique({ where: { storeId_orderId: { storeId: store.id, orderId } } });
  if (!block || block.status !== "BLOCKED") return { status: "Success" };

  const settings = await prisma.storeSettings.findUnique({ where: { storeId: store.id }, select: { expiryDays: true } });
  await postTransaction({
    storeId: store.id,
    customerId: block.customerId,
    type: "REVERSAL",
    points: block.points,
    expiresAt: expiryDate(settings?.expiryDays ?? 0),
    idempotencyKey: `fastrr-unblock:${block.id}`,
    note: `Shiprocket checkout order ${orderId} released`,
  });
  await prisma.loyaltyPointsBlock.update({ where: { id: block.id }, data: { status: "RELEASED" } });
  return { status: "Success" };
}

/** Fastrr's order webhook: SUCCESS confirms the debit, anything else releases it. A block that was
 * already settled (CONFIRMED/RELEASED), or an order we never blocked points for, is left alone. */
export async function handleOrderWebhook(store, payload) {
  const orderId = String(payload?.order_id ?? payload?.platform_order_id ?? "").trim();
  if (!orderId) return { ok: false, reason: "missing order_id" };
  const block = await prisma.loyaltyPointsBlock.findUnique({ where: { storeId_orderId: { storeId: store.id, orderId } } });
  if (!block || block.status !== "BLOCKED") return { ok: true };

  if (String(payload?.status || "").toUpperCase() === "SUCCESS") {
    await prisma.loyaltyPointsBlock.update({ where: { id: block.id }, data: { status: "CONFIRMED" } });
  } else {
    await unblockPoints(store, { order_id: orderId });
  }
  return { ok: true };
}
