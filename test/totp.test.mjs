import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  decodeBase32,
  encodeBase32,
  generateTotp,
  generateTotpSecret,
  verifyTotp,
} from "../src/totp.mjs";

// RFC 4226 appendix D: ASCII secret "12345678901234567890"
const RFC4226_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC4226_CODES = [
  "755224", "287082", "359152", "969429", "338314",
  "254676", "287922", "162583", "399871", "520489",
];

test("decodeBase32 decodes the RFC 4226 secret", () => {
  assert.equal(decodeBase32(RFC4226_SECRET_B32).toString("ascii"), "12345678901234567890");
});

test("decodeBase32 tolerates lowercase, whitespace, and padding", () => {
  const padded = "gezd gnbv gy3t qojq GEZDGNBVGY3TQOJQ====";
  assert.equal(decodeBase32(padded).toString("ascii"), "12345678901234567890");
});

test("decodeBase32 rejects invalid input", () => {
  assert.throws(() => decodeBase32(""), /empty/);
  assert.throws(() => decodeBase32("not base32!"), /base32/);
});

test("generateTotp matches the RFC 4226 HOTP vectors", () => {
  const key = decodeBase32(RFC4226_SECRET_B32);
  RFC4226_CODES.forEach((code, counter) => {
    assert.equal(generateTotp(key, counter), code);
  });
});

test("base32 encode/decode round-trips random buffers", () => {
  for (let length = 1; length <= 30; length += 1) {
    const buffer = crypto.randomBytes(length);
    assert.deepEqual(decodeBase32(encodeBase32(buffer)), buffer);
  }
});

test("verifyTotp accepts the current code and returns its counter", () => {
  const secret = generateTotpSecret();
  const key = decodeBase32(secret);
  const now = Date.now();
  const counter = Math.floor(now / 1000 / 30);
  const code = generateTotp(key, counter);
  assert.equal(verifyTotp(code, secret, { now }), counter);
});

test("verifyTotp accepts adjacent-window codes", () => {
  const secret = generateTotpSecret();
  const key = decodeBase32(secret);
  const now = Date.now();
  const counter = Math.floor(now / 1000 / 30);
  assert.equal(verifyTotp(generateTotp(key, counter - 1), secret, { now }), counter - 1);
  assert.equal(verifyTotp(generateTotp(key, counter + 1), secret, { now }), counter + 1);
});

test("verifyTotp rejects replayed counters", () => {
  const secret = generateTotpSecret();
  const key = decodeBase32(secret);
  const now = Date.now();
  const counter = Math.floor(now / 1000 / 30);
  const code = generateTotp(key, counter);
  assert.equal(verifyTotp(code, secret, { now, lastCounter: counter }), null);
  // A later counter's code is still accepted after a replayed one is refused.
  const nextCode = generateTotp(key, counter + 1);
  assert.equal(verifyTotp(nextCode, secret, { now, lastCounter: counter }), counter + 1);
});

test("verifyTotp rejects malformed codes", () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp("", secret), null);
  assert.equal(verifyTotp("12345", secret), null);
  assert.equal(verifyTotp("1234567", secret), null);
  assert.equal(verifyTotp("abcdef", secret), null);
});

test("generateTotpSecret produces 32-char base32", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(decodeBase32(secret).length, 20);
});
