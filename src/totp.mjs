import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;

export function decodeBase32(input) {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/\s+/g, "");
  if (!clean) throw new Error("TOTP secret is empty");

  const out = Buffer.alloc(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const v = BASE32_ALPHABET.indexOf(char);
    if (v === -1) throw new Error("TOTP secret must be base32 encoded");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >>> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

export function encodeBase32(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i < bits.length; i += 5) {
    output += BASE32_ALPHABET[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

export function generateTotp(key, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Verify a TOTP code. Returns the matched time counter so the caller can
 * persist it and reject replays (any counter <= lastCounter is refused).
 * Returns null when the code does not match.
 */
export function verifyTotp(code, secret, { window = 1, lastCounter = null, now = Date.now() } = {}) {
  if (!/^\d{6}$/.test(code)) return null;
  const key = decodeBase32(secret);
  const nowCounter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = nowCounter + offset;
    if (lastCounter != null && counter <= lastCounter) continue;
    if (safeEqual(generateTotp(key, counter), code)) return counter;
  }
  return null;
}

export function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

export function generateSharedSecret() {
  return crypto.randomBytes(24).toString("hex");
}

export function safeEqual(a, b) {
  // Hash both inputs to fixed-length digests to avoid leaking length info
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}
