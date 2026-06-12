import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UnlockManager } from "../src/unlock.mjs";
import { decodeBase32, generateTotp, generateTotpSecret } from "../src/totp.mjs";

async function makeManager(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "telepi-unlock-"));
  const options = {
    stateFile: path.join(dir, "unlock-state.json"),
    ttlMinutes: 5,
    method: "secret",
    sharedSecret: "correct-horse",
    maxFailures: 3,
    lockoutMinutes: 15,
    ...overrides,
  };
  const manager = new UnlockManager(options);
  await manager.load();
  return { manager, options };
}

test("correct shared secret unlocks for the configured TTL", async () => {
  const { manager } = await makeManager();
  assert.equal(manager.isLocked(), true);
  const result = await manager.attemptUnlock("correct-horse", 42);
  assert.equal(result.ok, true);
  assert.equal(manager.isLocked(), false);
  assert.equal(manager.unlockedBy, 42);
  assert.ok(result.unlockedUntil > Date.now() + 4 * 60_000);
});

test("wrong codes count down to a lockout, then attempts are refused", async () => {
  const { manager } = await makeManager();
  let result = await manager.attemptUnlock("nope", 1);
  assert.deepEqual({ ok: result.ok, reason: result.reason, remainingAttempts: result.remainingAttempts }, { ok: false, reason: "bad-code", remainingAttempts: 2 });
  result = await manager.attemptUnlock("nope", 1);
  assert.equal(result.remainingAttempts, 1);
  result = await manager.attemptUnlock("nope", 1);
  assert.equal(result.reason, "lockout-started");

  // Even the correct secret is refused during lockout.
  result = await manager.attemptUnlock("correct-horse", 1);
  assert.equal(result.reason, "locked-out");
  assert.ok(result.retryAfterMs > 0);
});

test("lockout and failure count survive a restart", async () => {
  const { manager, options } = await makeManager();
  await manager.attemptUnlock("nope", 1);
  await manager.attemptUnlock("nope", 1);
  await manager.attemptUnlock("nope", 1);
  assert.equal(manager.isLockedOut(), true);

  const reloaded = new UnlockManager(options);
  await reloaded.load();
  assert.equal(reloaded.isLockedOut(), true);
});

test("successful unlock resets the failure counter", async () => {
  const { manager } = await makeManager();
  await manager.attemptUnlock("nope", 1);
  await manager.attemptUnlock("nope", 1);
  const ok = await manager.attemptUnlock("correct-horse", 1);
  assert.equal(ok.ok, true);
  // Failure budget is full again afterwards.
  const fail = await manager.attemptUnlock("nope", 1);
  assert.equal(fail.remainingAttempts, 2);
});

test("lockNow relocks and persists; expired state is cleared on load", async () => {
  const { manager, options } = await makeManager();
  await manager.attemptUnlock("correct-horse", 1);
  await manager.lockNow();
  assert.equal(manager.isLocked(), true);

  const reloaded = new UnlockManager(options);
  await reloaded.load();
  assert.equal(reloaded.isLocked(), true);
  assert.equal(reloaded.unlockedBy, null);
});

test("TOTP method rejects code reuse across attempts", async () => {
  const totpSecret = generateTotpSecret();
  const { manager } = await makeManager({ method: "totp", totpSecret, sharedSecret: undefined });
  const key = decodeBase32(totpSecret);
  const code = generateTotp(key, Math.floor(Date.now() / 1000 / 30));

  const first = await manager.attemptUnlock(code, 1);
  assert.equal(first.ok, true);
  const replay = await manager.attemptUnlock(code, 1);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "bad-code");
});

test("state file is written owner-only", async () => {
  const { manager, options } = await makeManager();
  await manager.attemptUnlock("correct-horse", 1);
  const info = await stat(options.stateFile);
  assert.equal(info.mode & 0o777, 0o600);
});
