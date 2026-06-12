import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeEqual, verifyTotp } from "./totp.mjs";

/**
 * Unlock state machine: TTL-based unlock, persisted state, failure counting
 * with temporary lockout, and TOTP replay protection (each accepted code's
 * time counter is persisted and may not be reused).
 */
export class UnlockManager {
  constructor({ stateFile, ttlMinutes, method, totpSecret, sharedSecret, maxFailures = 5, lockoutMinutes = 15 }) {
    this.stateFile = stateFile;
    this.ttlMs = ttlMinutes * 60_000;
    this.method = method;
    this.totpSecret = totpSecret;
    this.sharedSecret = sharedSecret;
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMinutes * 60_000;
    this.state = {
      unlockedUntil: 0,
      unlockedBy: null,
      failures: 0,
      lockoutUntil: 0,
      lastTotpCounter: null,
    };
  }

  get unlockedUntil() {
    return this.state.unlockedUntil;
  }

  get unlockedBy() {
    return this.state.unlockedBy;
  }

  isLocked() {
    return Date.now() >= this.state.unlockedUntil;
  }

  isLockedOut() {
    return Date.now() < this.state.lockoutUntil;
  }

  lockoutRemainingMs() {
    return Math.max(0, this.state.lockoutUntil - Date.now());
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8"));
      this.state.unlockedUntil = Number(parsed?.unlockedUntil) || 0;
      this.state.unlockedBy = parsed?.unlockedBy ?? null;
      this.state.failures = Number(parsed?.failures) || 0;
      this.state.lockoutUntil = Number(parsed?.lockoutUntil) || 0;
      this.state.lastTotpCounter = Number.isFinite(parsed?.lastTotpCounter) ? parsed.lastTotpCounter : null;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error("Failed to load unlock state:", error);
      }
    }

    if (this.isLocked() && this.state.unlockedUntil !== 0) {
      this.state.unlockedUntil = 0;
      this.state.unlockedBy = null;
      await this.#save();
    }
  }

  /**
   * Returns one of:
   *   { ok: true, unlockedUntil }
   *   { ok: false, reason: "locked-out", retryAfterMs }
   *   { ok: false, reason: "lockout-started", retryAfterMs }
   *   { ok: false, reason: "bad-code", remainingAttempts }
   */
  async attemptUnlock(code, by) {
    if (this.isLockedOut()) {
      return { ok: false, reason: "locked-out", retryAfterMs: this.lockoutRemainingMs() };
    }

    const normalized = String(code || "").trim();
    let matchedCounter = null;
    let ok = false;
    if (normalized) {
      if (this.method === "secret") {
        ok = safeEqual(normalized, this.sharedSecret);
      } else {
        matchedCounter = verifyTotp(normalized, this.totpSecret, { lastCounter: this.state.lastTotpCounter });
        ok = matchedCounter != null;
      }
    }

    if (!ok) {
      this.state.failures += 1;
      if (this.state.failures >= this.maxFailures) {
        this.state.failures = 0;
        this.state.lockoutUntil = Date.now() + this.lockoutMs;
        await this.#save();
        return { ok: false, reason: "lockout-started", retryAfterMs: this.lockoutMs };
      }
      await this.#save();
      return { ok: false, reason: "bad-code", remainingAttempts: this.maxFailures - this.state.failures };
    }

    this.state.failures = 0;
    this.state.lockoutUntil = 0;
    if (matchedCounter != null) this.state.lastTotpCounter = matchedCounter;
    this.state.unlockedUntil = Date.now() + this.ttlMs;
    this.state.unlockedBy = by;
    await this.#save();
    return { ok: true, unlockedUntil: this.state.unlockedUntil };
  }

  /** Unlock without a code; used for the local (SIGUSR1) unlock path only. */
  async unlockWithoutCode(by) {
    this.state.unlockedUntil = Date.now() + this.ttlMs;
    this.state.unlockedBy = by;
    await this.#save();
    return this.state.unlockedUntil;
  }

  async lockNow() {
    if (this.state.unlockedUntil === 0) return;
    this.state.unlockedUntil = 0;
    this.state.unlockedBy = null;
    await this.#save();
  }

  async relockIfExpired() {
    if (this.isLocked()) await this.lockNow();
  }

  async #save() {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const payload = JSON.stringify({ ...this.state, savedAt: new Date().toISOString() }, null, 2);
    const tempFile = `${this.stateFile}.tmp`;
    await writeFile(tempFile, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempFile, this.stateFile);
  }
}
