import test from "node:test";
import assert from "node:assert/strict";

import {
  toPaise,
  formatINR,
  paiseToInput,
  sanitizeQuantity,
  rateToPaise,
  computeTotalPaise,
  isPaymentMethod,
  statusForMethod,
  methodLabel,
  MAX_QUANTITY,
  MAX_RATE_PAISE,
} from "../js/utils.js";

test("toPaise: rupees -> integer paise", () => {
  assert.equal(toPaise(10), 1000);
  assert.equal(toPaise("10"), 1000);
  assert.equal(toPaise("10.5"), 1050);
  assert.equal(toPaise("10.50"), 1050);
  assert.equal(toPaise("₹10,000"), 1000000);
  assert.ok(Number.isNaN(toPaise("abc")));
  assert.ok(Number.isNaN(toPaise("")));
  assert.ok(Number.isNaN(toPaise(null)));
});

test("sanitizeQuantity: accepts whole numbers above zero", () => {
  assert.equal(sanitizeQuantity("1"), 1);
  assert.equal(sanitizeQuantity(1), 1);
  assert.equal(sanitizeQuantity("5"), 5);
  assert.equal(sanitizeQuantity(" "), null);
  assert.equal(sanitizeQuantity(0), null);
  assert.equal(sanitizeQuantity(-3), null);
  assert.equal(sanitizeQuantity("1.5"), null);
  assert.equal(sanitizeQuantity("abc"), null);
  assert.equal(sanitizeQuantity(Number.NaN), null);
  assert.equal(sanitizeQuantity(Number.POSITIVE_INFINITY), null);
  assert.equal(sanitizeQuantity(Number.NEGATIVE_INFINITY), null);
  assert.equal(sanitizeQuantity(MAX_QUANTITY + 1), null);
  assert.equal(sanitizeQuantity(MAX_QUANTITY), MAX_QUANTITY);
});

test("rateToPaise: safe rate parsing", () => {
  assert.equal(rateToPaise("10"), 1000);
  assert.equal(rateToPaise("10.50"), 1050);
  assert.equal(rateToPaise("0"), 0);
  assert.equal(rateToPaise("0.00"), 0);
  assert.equal(rateToPaise("-5"), null);
  assert.equal(rateToPaise("abc"), null);
  assert.equal(rateToPaise(Number.NaN), null);
  assert.equal(rateToPaise(Number.POSITIVE_INFINITY), null);
  assert.equal(rateToPaise(MAX_RATE_PAISE / 100), MAX_RATE_PAISE);
  assert.equal(rateToPaise(MAX_RATE_PAISE / 100 + 0.01), null);
});

test("computeTotalPaise: quantity x rate with integer math", () => {
  assert.equal(computeTotalPaise(2, 500), 1000);
  assert.equal(computeTotalPaise(1, 0), 0);
  assert.equal(computeTotalPaise(3, 1050), 3150);
  assert.equal(computeTotalPaise(0, 500), null);
  assert.equal(computeTotalPaise(-1, 500), null);
  assert.equal(computeTotalPaise(1, -1), null);
  assert.equal(computeTotalPaise(1.5, 500), null);
  assert.equal(computeTotalPaise(Number.NaN, 500), null);
  assert.equal(computeTotalPaise(1, Number.NaN), null);
  assert.equal(computeTotalPaise(Number.POSITIVE_INFINITY, 500), null);
});

test("payment methods + status mapping", () => {
  assert.equal(isPaymentMethod("cash"), true);
  assert.equal(isPaymentMethod("upi"), true);
  assert.equal(isPaymentMethod("card"), true);
  assert.equal(isPaymentMethod("due"), true);
  assert.equal(isPaymentMethod("CASH"), false);
  assert.equal(isPaymentMethod("cheque"), false);
  assert.equal(isPaymentMethod(null), false);

  assert.equal(statusForMethod("due"), "pending");
  assert.equal(statusForMethod("cash"), "paid");
  assert.equal(statusForMethod("upi"), "paid");
  assert.equal(statusForMethod("card"), "paid");
  assert.equal(statusForMethod("nope"), null);

  assert.equal(methodLabel("cash"), "Cash");
  assert.equal(methodLabel("upi"), "UPI");
  assert.equal(methodLabel("card"), "Card");
  assert.equal(methodLabel("due"), "Due");
});

test("format helpers", () => {
  assert.equal(formatINR(1050), "₹10.50");
  assert.equal(formatINR(500), "₹5");
  assert.equal(formatINR(0), "₹0");
  assert.equal(paiseToInput(1050), "10.50");
  assert.equal(paiseToInput(500), "5");
  assert.equal(paiseToInput(0), "0");
});