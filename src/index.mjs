import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { Bot } from "grammy";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

dotenv.config();

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(BASE_DIR, "data");
const LOGS_DIR = path.join(BASE_DIR, "logs");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const UNLOCK_STATE_FILE = process.env.UNLOCK_STATE_FILE?.trim() || path.join(DATA_DIR, "unlock-state.json");
const TELEGRAM_BOT_TOKEN = requiredEnv("TELEGRAM_BOT_TOKEN");
const OWNER_TELEGRAM_USER_ID = requiredNumericEnv("OWNER_TELEGRAM_USER_ID");
const OWNER_CHAT_ID = optionalNumericEnv("OWNER_CHAT_ID");
const PI_WORKSPACE_DIR = path.resolve(process.env.PI_WORKSPACE_DIR || process.cwd());
const PI_AGENT_DIR = expandHome(process.env.PI_AGENT_DIR || "~/.pi/agent");
const PI_THINKING_LEVEL = process.env.PI_THINKING_LEVEL || undefined;
const TELEGRAM_MAX_MESSAGE = 4000;
const TYPING_INTERVAL_MS = 4000;
const ALLOW_PRIVATE_CHATS_ONLY = parseBoolean(process.env.ALLOW_PRIVATE_CHATS_ONLY, true);
const UNLOCK_METHOD = (process.env.UNLOCK_METHOD || "totp").trim().toLowerCase();
const UNLOCK_TTL_MINUTES = Math.max(1, Number(process.env.UNLOCK_TTL_MINUTES || 15));
const ALERT_OWNER_ON_DENIED = parseBoolean(process.env.ALERT_OWNER_ON_DENIED, true);
const AUDIT_LOG_FILE = process.env.AUDIT_LOG_FILE?.trim() || path.join(LOGS_DIR, "audit.log");
const MAX_TEXT_LENGTH = Math.max(1, Number(process.env.MAX_TEXT_LENGTH || 12000));
const ALERT_DEDUP_WINDOW_MS = 60_000;

const SHARED_SECRET = UNLOCK_METHOD === "secret" ? requiredEnv("UNLOCK_SHARED_SECRET") : undefined;
const TOTP_SECRET = UNLOCK_METHOD === "totp" ? requiredEnv("UNLOCK_TOTP_SECRET") : undefined;

if (!["totp", "secret"].includes(UNLOCK_METHOD)) {
  throw new Error("UNLOCK_METHOD must be 'totp' or 'secret'");
}

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);
const fixedModel = resolveModelFromEnv();

class PiSessionPool {
  constructor({ workspaceDir, agentDir, thinkingLevel, model }) {
    this.workspaceDir = workspaceDir;
    this.agentDir = agentDir;
    this.thinkingLevel = thinkingLevel;
    this.model = model;
    this.sessions = new Map();
  }

  async get(chatId) {
    const key = String(chatId);
    if (this.sessions.has(key)) return this.sessions.get(key);

    const sessionDir = path.join(SESSIONS_DIR, key);
    await mkdir(sessionDir, { recursive: true });

    const entry = createAgentSession({
      cwd: this.workspaceDir,
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      sessionManager: SessionManager.continueRecent(this.workspaceDir, sessionDir),
    }).then(({ session, modelFallbackMessage }) => {
      if (modelFallbackMessage) {
        console.warn(`[chat ${chatId}] ${modelFallbackMessage}`);
      }
      return session;
    });

    this.sessions.set(key, entry);
    return entry;
  }

  async clear(chatId) {
    const key = String(chatId);
    const existing = this.sessions.get(key);
    if (existing) {
      try {
        const session = await existing;
        session.dispose();
      } catch {
        // Ignore broken session during clear.
      }
      this.sessions.delete(key);
    }

    await rm(path.join(SESSIONS_DIR, key), { recursive: true, force: true });
  }

  async disposeAll() {
    const entries = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const entry of entries) {
      try {
        const session = await entry;
        session.dispose();
      } catch {
        // Ignore dispose failures.
      }
    }
  }
}

const sessionPool = new PiSessionPool({
  workspaceDir: PI_WORKSPACE_DIR,
  agentDir: PI_AGENT_DIR,
  thinkingLevel: PI_THINKING_LEVEL,
  model: fixedModel,
});
const bot = new Bot(TELEGRAM_BOT_TOKEN);
const chatLocks = new Map();
const recentAlerts = new Map();
const unlockState = {
  unlockedUntil: 0,
  unlockedBy: null,
};

await mkdir(SESSIONS_DIR, { recursive: true });
await mkdir(path.dirname(AUDIT_LOG_FILE), { recursive: true });
await mkdir(path.dirname(UNLOCK_STATE_FILE), { recursive: true });
await loadUnlockState();

bot.use(async (ctx, next) => {
  const decision = await authorize(ctx);
  if (!decision.ok) return;
  await next();
});

bot.command("start", async (ctx) => {
  await audit("START", ctx, { locked: isLocked() });
  await ctx.reply(
    [
      "Remote admin bridge is ready.",
      `State: ${isLocked() ? "locked" : `unlocked until ${new Date(unlockState.unlockedUntil).toISOString()}`}`,
      "Commands: /status, /unlock <code>, /lock, /clear",
    ].join("\n")
  );
});

bot.command("status", async (ctx) => {
  await audit("STATUS", ctx, { locked: isLocked() });
  await ctx.reply(
    isLocked()
      ? "Status: locked"
      : `Status: unlocked until ${new Date(unlockState.unlockedUntil).toISOString()}`
  );
});

bot.command("unlock", async (ctx) => {
  const code = commandArgs(ctx.message?.text);
  const success = verifyUnlockCode(code);

  if (!success) {
    await audit("UNLOCK_FAILURE", ctx, {});
    await alertOwner(
      `Failed unlock attempt from owner account. chat_id=${ctx.chat.id} time=${new Date().toISOString()}`,
      "unlock-failure"
    );
    await ctx.reply("Unlock failed.");
    return;
  }

  unlockState.unlockedUntil = Date.now() + UNLOCK_TTL_MINUTES * 60_000;
  unlockState.unlockedBy = ctx.from?.id ?? null;
  await saveUnlockState();
  await audit("UNLOCK_SUCCESS", ctx, { unlockedUntil: new Date(unlockState.unlockedUntil).toISOString() });
  await ctx.reply(`Unlocked for ${UNLOCK_TTL_MINUTES} minutes.`);
});

bot.command("lock", async (ctx) => {
  await lockNow();
  await audit("LOCK", ctx, {});
  await ctx.reply("Locked.");
});

bot.command("clear", async (ctx) => {
  if (isLocked()) {
    await audit("CLEAR_DENIED_LOCKED", ctx, {});
    await ctx.reply("Locked. Use /unlock first.");
    return;
  }

  await withChatLock(ctx.chat.id, async () => {
    await sessionPool.clear(ctx.chat.id);
    await audit("CLEAR", ctx, {});
    await ctx.reply("Cleared this chat's pi session.");
  });
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text?.trim();
  if (!text) return;
  if (text.startsWith("/")) return;

  if (text.length > MAX_TEXT_LENGTH) {
    await audit("PROMPT_REJECTED_TOO_LONG", ctx, { length: text.length });
    await ctx.reply(`Message too long. Max length is ${MAX_TEXT_LENGTH} characters.`);
    return;
  }

  if (isLocked()) {
    await audit("PROMPT_DENIED_LOCKED", ctx, {});
    await ctx.reply("Locked. Use /unlock first.");
    return;
  }

  await withChatLock(ctx.chat.id, async () => {
    const typingTimer = setInterval(() => {
      ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      await audit("PROMPT_START", ctx, { preview: safePreview(text) });
      await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const session = await sessionPool.get(ctx.chat.id);
      let replyText = "";

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          replyText += event.assistantMessageEvent.delta;
        }
      });

      try {
        await session.prompt(text);
      } finally {
        unsubscribe();
      }

      replyText = replyText.trim() || "(No text response produced.)";
      for (const chunk of splitForTelegram(replyText)) {
        await ctx.reply(chunk);
      }
      await audit("PROMPT_END", ctx, { responseLength: replyText.length });
    } catch (error) {
      console.error(`Chat ${ctx.chat.id} failed:`, error);
      await audit("PROMPT_ERROR", ctx, { error: error?.message || String(error) });
      await ctx.reply("Request failed. See logs.");
    } finally {
      clearInterval(typingTimer);
      if (Date.now() >= unlockState.unlockedUntil) {
        await lockNow();
      }
    }
  });
});

bot.catch(async (error) => {
  console.error("Telegram bridge error:", error);
  await appendAuditLine({
    time: new Date().toISOString(),
    event: "BOT_ERROR",
    error: error?.message || String(error),
  });
});

let shuttingDown = false;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const me = await bot.api.getMe();
console.log(`Starting Telegram pi bridge as @${me.username}`);
console.log(`Workspace: ${PI_WORKSPACE_DIR}`);
console.log(`Agent dir: ${PI_AGENT_DIR}`);
console.log(`Owner user id: ${OWNER_TELEGRAM_USER_ID}`);
console.log(`Private chats only: ${ALLOW_PRIVATE_CHATS_ONLY}`);
console.log(`Unlock method: ${UNLOCK_METHOD}`);
await appendAuditLine({
  time: new Date().toISOString(),
  event: "STARTUP",
  workspace: PI_WORKSPACE_DIR,
  agentDir: PI_AGENT_DIR,
  ownerUserId: OWNER_TELEGRAM_USER_ID,
  ownerChatId: OWNER_CHAT_ID,
  unlockMethod: UNLOCK_METHOD,
  privateOnly: ALLOW_PRIVATE_CHATS_ONLY,
  unlockedUntil: unlockState.unlockedUntil || null,
});
await startBotWithRetry();

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down Telegram pi bridge...");
  bot.stop();
  await appendAuditLine({ time: new Date().toISOString(), event: "SHUTDOWN" });
  await sessionPool.disposeAll();
  process.exit(0);
}

async function startBotWithRetry() {
  while (!shuttingDown) {
    try {
      await bot.start();
      return;
    } catch (error) {
      if (shuttingDown) return;

      const description = error?.description || error?.message || String(error);
      const isConflict = error?.error_code === 409 || /other getUpdates request/i.test(description);
      const retryDelayMs = isConflict ? 5000 : 15000;
      const event = isConflict ? "BOT_POLL_CONFLICT" : "BOT_START_ERROR";

      try {
        bot.stop();
      } catch {
        // Ignore stop failures during retry.
      }

      console.error(`Telegram bridge ${isConflict ? "poll conflict" : "start error"}:`, error);
      await appendAuditLine({
        time: new Date().toISOString(),
        event,
        error: description,
        retryDelayMs,
      });

      await sleep(retryDelayMs);
    }
  }
}

async function authorize(ctx) {
  const meta = contextMeta(ctx);

  if (ALLOW_PRIVATE_CHATS_ONLY && ctx.chat?.type !== "private") {
    await deny("DENIED_CHAT_TYPE", ctx, { expected: "private" }, true);
    return { ok: false };
  }

  if (ctx.from?.id !== OWNER_TELEGRAM_USER_ID) {
    await deny("DENIED_USER", ctx, { ownerUserId: OWNER_TELEGRAM_USER_ID }, true);
    return { ok: false };
  }

  if (OWNER_CHAT_ID != null && ctx.chat?.id !== OWNER_CHAT_ID) {
    await deny("DENIED_CHAT_ID", ctx, { ownerChatId: OWNER_CHAT_ID }, true);
    return { ok: false };
  }

  await appendAuditLine({ time: new Date().toISOString(), event: "AUTHORIZED", ...meta });
  return { ok: true };
}

async function deny(event, ctx, extra = {}, alert = false) {
  const meta = contextMeta(ctx);
  await appendAuditLine({ time: new Date().toISOString(), event, ...meta, ...extra });
  if (alert && ALERT_OWNER_ON_DENIED) {
    const fingerprint = `${event}:${meta.fromId}:${meta.chatId}`;
    await alertOwner(
      [
        `Unauthorized attempt detected`,
        `event=${event}`,
        `from_id=${meta.fromId}`,
        `username=${meta.username}`,
        `chat_id=${meta.chatId}`,
        `chat_type=${meta.chatType}`,
        `text=${meta.textPreview}`,
        `time=${new Date().toISOString()}`,
      ].join("\n"),
      fingerprint
    );
  }
}

async function audit(event, ctx, extra = {}) {
  await appendAuditLine({
    time: new Date().toISOString(),
    event,
    ...contextMeta(ctx),
    ...extra,
  });
}

async function appendAuditLine(entry) {
  await appendFile(AUDIT_LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
}

async function alertOwner(text, fingerprint = "default") {
  const now = Date.now();
  const last = recentAlerts.get(fingerprint) || 0;
  if (now - last < ALERT_DEDUP_WINDOW_MS) return;
  recentAlerts.set(fingerprint, now);

  try {
    await bot.api.sendMessage(OWNER_CHAT_ID ?? OWNER_TELEGRAM_USER_ID, text);
  } catch (error) {
    console.error("Failed to send owner alert:", error);
    await appendAuditLine({
      time: new Date().toISOString(),
      event: "ALERT_SEND_FAILURE",
      error: error?.message || String(error),
      fingerprint,
    });
  }
}

function isLocked() {
  return Date.now() >= unlockState.unlockedUntil;
}

async function lockNow() {
  unlockState.unlockedUntil = 0;
  unlockState.unlockedBy = null;
  await saveUnlockState();
}

async function loadUnlockState() {
  try {
    const raw = await readFile(UNLOCK_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    unlockState.unlockedUntil = Number(parsed?.unlockedUntil) || 0;
    unlockState.unlockedBy = parsed?.unlockedBy ?? null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Failed to load unlock state:", error);
    }
    unlockState.unlockedUntil = 0;
    unlockState.unlockedBy = null;
  }

  if (Date.now() >= unlockState.unlockedUntil) {
    unlockState.unlockedUntil = 0;
    unlockState.unlockedBy = null;
    await saveUnlockState();
  }
}

async function saveUnlockState() {
  const payload = JSON.stringify(
    {
      unlockedUntil: unlockState.unlockedUntil,
      unlockedBy: unlockState.unlockedBy,
      savedAt: new Date().toISOString(),
    },
    null,
    2
  );
  const tempFile = `${UNLOCK_STATE_FILE}.tmp`;
  await writeFile(tempFile, `${payload}\n`, "utf8");
  await rename(tempFile, UNLOCK_STATE_FILE);
}

function verifyUnlockCode(code) {
  const normalized = String(code || "").trim();
  if (!normalized) return false;

  if (UNLOCK_METHOD === "secret") {
    return safeEqual(normalized, SHARED_SECRET);
  }

  return verifyTotp(normalized, TOTP_SECRET);
}

function verifyTotp(code, secret) {
  if (!/^\d{6}$/.test(code)) return false;
  const key = decodeBase32(secret);
  const step = 30;
  const nowCounter = Math.floor(Date.now() / 1000 / step);
  for (const offset of [-1, 0, 1]) {
    if (generateTotp(key, nowCounter + offset) === code) return true;
  }
  return false;
}

function generateTotp(key, counter) {
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

function decodeBase32(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/\s+/g, "");
  if (!clean) throw new Error("UNLOCK_TOTP_SECRET is empty");

  let bits = "";
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value === -1) throw new Error("UNLOCK_TOTP_SECRET must be base32 encoded");
    bits += value.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredNumericEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function optionalNumericEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric`);
  return value;
}

function expandHome(input) {
  if (!input.startsWith("~")) return input;
  return path.join(os.homedir(), input.slice(1));
}

function commandArgs(text) {
  const raw = String(text || "").trim();
  const firstSpace = raw.indexOf(" ");
  return firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
}

function splitForTelegram(text) {
  if (text.length <= TELEGRAM_MAX_MESSAGE) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MAX_MESSAGE) {
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", TELEGRAM_MAX_MESSAGE);
    if (splitAt < 1000) splitAt = TELEGRAM_MAX_MESSAGE;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function withChatLock(chatId, task) {
  const key = String(chatId);
  const previous = chatLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate);
  chatLocks.set(key, chain);

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (chatLocks.get(key) === chain) {
      chatLocks.delete(key);
    }
  }
}

function resolveModelFromEnv() {
  const provider = process.env.PI_MODEL_PROVIDER?.trim();
  const modelName = process.env.PI_MODEL_NAME?.trim();
  if (!provider || !modelName) return undefined;
  const model = getModel(provider, modelName);
  if (!model) {
    throw new Error(`Unknown model: ${provider}/${modelName}`);
  }
  return model;
}

function contextMeta(ctx) {
  return {
    fromId: ctx.from?.id ?? null,
    username: ctx.from?.username ?? null,
    chatId: ctx.chat?.id ?? null,
    chatType: ctx.chat?.type ?? null,
    textPreview: safePreview(ctx.message?.text || ""),
  };
}

function safePreview(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
