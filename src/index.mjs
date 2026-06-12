import { mkdir } from "node:fs/promises";
import path from "node:path";

import dotenv from "dotenv";
import { Bot } from "grammy";
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import { APP_DIR, DATA_DIR, LOGS_DIR, SESSIONS_DIR, expandHome, sleep } from "./paths.mjs";
import { createAuditLogger, tightenLogPermissions } from "./audit.mjs";
import { PiSessionPool } from "./session-pool.mjs";
import { commandArgs, parseBoolean, safePreview, splitForTelegram } from "./telegram-format.mjs";
import { UnlockManager } from "./unlock.mjs";

dotenv.config({ path: path.join(APP_DIR, ".env") });
const UNLOCK_STATE_FILE = process.env.UNLOCK_STATE_FILE?.trim() || path.join(DATA_DIR, "unlock-state.json");
const TELEGRAM_BOT_TOKEN = requiredEnv("TELEGRAM_BOT_TOKEN");
const OWNER_TELEGRAM_USER_ID = requiredNumericEnv("OWNER_TELEGRAM_USER_ID");
const OWNER_CHAT_ID = optionalNumericEnv("OWNER_CHAT_ID");
const PI_WORKSPACE_DIR = path.resolve(process.env.PI_WORKSPACE_DIR || process.cwd());
const PI_AGENT_DIR = expandHome(process.env.PI_AGENT_DIR || "~/.pi/agent");
const PI_THINKING_LEVEL = process.env.PI_THINKING_LEVEL || undefined;
const TYPING_INTERVAL_MS = 4000;
const ALLOW_PRIVATE_CHATS_ONLY = parseBoolean(process.env.ALLOW_PRIVATE_CHATS_ONLY, true);
const UNLOCK_METHOD = (process.env.UNLOCK_METHOD || "totp").trim().toLowerCase();
const UNLOCK_TTL_MINUTES = Math.max(1, Number(process.env.UNLOCK_TTL_MINUTES || 15));
const UNLOCK_MAX_FAILURES = Math.max(1, Number(process.env.UNLOCK_MAX_FAILURES || 5));
const UNLOCK_LOCKOUT_MINUTES = Math.max(1, Number(process.env.UNLOCK_LOCKOUT_MINUTES || 15));
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

const sessionPool = new PiSessionPool({
  workspaceDir: PI_WORKSPACE_DIR,
  agentDir: PI_AGENT_DIR,
  thinkingLevel: PI_THINKING_LEVEL,
  model: fixedModel,
  sessionsDir: SESSIONS_DIR,
  authStorage,
  modelRegistry,
});
const bot = new Bot(TELEGRAM_BOT_TOKEN);
const chatLocks = new Map();
const recentAlerts = new Map();
const unlockManager = new UnlockManager({
  stateFile: UNLOCK_STATE_FILE,
  ttlMinutes: UNLOCK_TTL_MINUTES,
  method: UNLOCK_METHOD,
  totpSecret: TOTP_SECRET,
  sharedSecret: SHARED_SECRET,
  maxFailures: UNLOCK_MAX_FAILURES,
  lockoutMinutes: UNLOCK_LOCKOUT_MINUTES,
});
const appendAuditLine = createAuditLogger(AUDIT_LOG_FILE);

await mkdir(SESSIONS_DIR, { recursive: true });
await tightenLogPermissions(AUDIT_LOG_FILE);
await unlockManager.load();

bot.use(async (ctx, next) => {
  const decision = await authorize(ctx);
  if (!decision.ok) return;
  await next();
});

bot.command("start", async (ctx) => {
  await audit("START", ctx, { locked: unlockManager.isLocked() });
  await ctx.reply(
    [
      "Remote admin bridge is ready.",
      `State: ${lockStateText()}`,
      "Use /help to see commands.",
    ].join("\n")
  );
});

bot.command("help", async (ctx) => {
  await audit("HELP", ctx, {});
  await ctx.reply(helpText());
});

bot.command("status", async (ctx) => {
  await audit("STATUS", ctx, { locked: unlockManager.isLocked() });
  const lines = [`Status: ${lockStateText()}`];
  if (unlockManager.isLockedOut()) {
    lines.push(`Unlock disabled for ${formatMinutes(unlockManager.lockoutRemainingMs())} after repeated failures.`);
  }
  await ctx.reply(lines.join("\n"));
});

bot.command("unlock", async (ctx) => {
  const code = commandArgs(ctx.message?.text);
  // Remove the message so the code does not linger in chat history.
  if (ctx.message?.message_id) {
    ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  }

  if (!code) {
    await audit("UNLOCK_MISSING_CODE", ctx, {});
    await ctx.reply("Usage: /unlock <code>");
    return;
  }

  const result = await unlockManager.attemptUnlock(code, ctx.from?.id ?? null);

  if (result.ok) {
    await audit("UNLOCK_SUCCESS", ctx, {
      textPreview: "/unlock <redacted>",
      unlockedUntil: new Date(result.unlockedUntil).toISOString(),
    });
    await ctx.reply(`Unlocked for ${UNLOCK_TTL_MINUTES} minutes.`);
    return;
  }

  if (result.reason === "locked-out") {
    await audit("UNLOCK_DENIED_LOCKOUT", ctx, { retryAfterMs: result.retryAfterMs });
    await ctx.reply(`Unlock is temporarily disabled after repeated failures. Try again in ${formatMinutes(result.retryAfterMs)}.`);
    return;
  }

  if (result.reason === "lockout-started") {
    await audit("UNLOCK_LOCKOUT_STARTED", ctx, { retryAfterMs: result.retryAfterMs });
    await alertOwner(
      `Unlock locked out after ${UNLOCK_MAX_FAILURES} failed attempts. chat_id=${ctx.chat.id} time=${new Date().toISOString()}`,
      "unlock-lockout"
    );
    await ctx.reply(`Unlock failed. Too many attempts — unlock disabled for ${UNLOCK_LOCKOUT_MINUTES} minutes.`);
    return;
  }

  await audit("UNLOCK_FAILURE", ctx, { remainingAttempts: result.remainingAttempts });
  await alertOwner(
    `Failed unlock attempt from owner account. chat_id=${ctx.chat.id} time=${new Date().toISOString()}`,
    "unlock-failure"
  );
  await ctx.reply(`Unlock failed. ${result.remainingAttempts} attempt${result.remainingAttempts === 1 ? "" : "s"} left before temporary lockout.`);
});

bot.command("lock", async (ctx) => {
  await unlockManager.lockNow();
  await audit("LOCK", ctx, {});
  await ctx.reply("Locked.");
});

const protectedRoute = bot.filter(async (ctx) => {
  if (unlockManager.isLocked()) {
    await audit("DENIED_LOCKED", ctx, { command: ctx.message?.text });
    await ctx.reply("Locked. Use /unlock first.");
    return false;
  }
  return true;
});

protectedRoute.use(async (ctx, next) => {
  if (!ctx.chat?.id) return next();
  return withChatLock(ctx.chat.id, () => next());
});

protectedRoute.command("clear", async (ctx) => {
  await sessionPool.clear(ctx.chat.id);
  await audit("CLEAR", ctx, {});
  await ctx.reply("Cleared this chat's pi session.");
});

protectedRoute.command("new", async (ctx) => {
  const session = await sessionPool.newSession(ctx.chat.id);
  await audit("NEW_SESSION", ctx, { sessionId: session.sessionId, sessionFile: session.sessionFile });
  await ctx.reply("Started a fresh session for this chat.");
});

protectedRoute.command("session", async (ctx) => {
  const session = await sessionPool.get(ctx.chat.id);
  const stats = session.getSessionStats();
  await audit("SESSION_INFO", ctx, { sessionId: stats.sessionId, sessionFile: stats.sessionFile });
  await ctx.reply(formatSessionInfo(session, stats, ctx.chat.id));
});

protectedRoute.command("compact", async (ctx) => {
  const instructions = commandArgs(ctx.message?.text);
  try {
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const session = await sessionPool.get(ctx.chat.id);
    await session.compact(instructions || undefined);
    await audit("COMPACT", ctx, { customInstructions: Boolean(instructions), sessionId: session.sessionId });
    await ctx.reply(instructions ? "Compacted session with custom instructions." : "Compacted session.");
  } catch (error) {
    await audit("COMPACT_ERROR", ctx, { error: error?.message || String(error) });
    await ctx.reply(`Compaction failed: ${error?.message || String(error)}`);
  }
});

protectedRoute.command("name", async (ctx) => {
  const name = commandArgs(ctx.message?.text);
  if (!name) {
    await audit("NAME_MISSING", ctx, {});
    await ctx.reply("Usage: /name <label>");
    return;
  }

  const session = await sessionPool.get(ctx.chat.id);
  session.setSessionName(name);
  await audit("SESSION_NAMED", ctx, { sessionId: session.sessionId, name });
  await ctx.reply(`Named this session: ${name}`);
});

protectedRoute.command("resume", async (ctx) => {
  const arg = commandArgs(ctx.message?.text);
  const sessions = await sessionPool.list(ctx.chat.id);
  if (!sessions.length) {
    await audit("RESUME_EMPTY", ctx, {});
    await ctx.reply("No saved sessions found for this chat.");
    return;
  }

  if (!arg) {
    await audit("RESUME_LIST", ctx, { count: sessions.length });
    await ctx.reply(formatResumeList(sessions));
    return;
  }

  const index = Number(arg);
  let selected;
  let selectedIndex = null;

  if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
    selectedIndex = index;
    selected = sessions[index - 1];
  } else {
    const matches = sessions.filter((entry) => {
      const name = String(entry.name || "").trim().toLowerCase();
      const query = arg.trim().toLowerCase();
      return name && (name === query || name.startsWith(query));
    });

    if (matches.length === 1) {
      selected = matches[0];
      selectedIndex = sessions.findIndex((entry) => entry.path === selected.path) + 1;
    } else if (matches.length > 1) {
      await audit("RESUME_AMBIGUOUS_NAME", ctx, { arg, matches: matches.length });
      await ctx.reply(`More than one session matches '${arg}'. Use /resume to list them, then choose a number.`);
      return;
    } else {
      await audit("RESUME_BAD_TARGET", ctx, { arg, count: sessions.length });
      await ctx.reply(`No session matched '${arg}'. Use /resume to list sessions, then pick a number or exact name.`);
      return;
    }
  }

  const session = await sessionPool.resume(ctx.chat.id, selected.path);
  await audit("RESUME_OPEN", ctx, { index: selectedIndex, sessionId: session.sessionId, sessionFile: session.sessionFile });
  await ctx.reply([
    `Resumed session ${selectedIndex}.`,
    `Name: ${selected.name || "(unnamed)"}`,
    `Updated: ${selected.modified.toISOString()}`,
    `First message: ${safePreview(selected.firstMessage || "") || "(empty)"}`,
  ].join("\n"));
});

protectedRoute.on("message:text", async (ctx) => {
  const text = ctx.message.text?.trim();
  if (!text) return;
  if (text.startsWith("/")) return;

  if (text.length > MAX_TEXT_LENGTH) {
    await audit("PROMPT_REJECTED_TOO_LONG", ctx, { length: text.length });
    await ctx.reply(`Message too long. Max length is ${MAX_TEXT_LENGTH} characters.`);
    return;
  }

  const typingTimer = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => { });
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
    await unlockManager.relockIfExpired();
  }
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
process.on("SIGUSR1", () => {
  unlockFromLocalTui().catch((error) => {
    console.error("Local TUI unlock failed:", error);
    appendAuditLine({
      time: new Date().toISOString(),
      event: "LOCAL_UNLOCK_ERROR",
      error: error?.message || String(error),
    });
  });
});

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
  unlockedUntil: unlockManager.unlockedUntil || null,
});
await startBotWithRetry();

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down Telegram pi bridge...");
  await bot.stop().catch(() => {});
  await appendAuditLine({ time: new Date().toISOString(), event: "SHUTDOWN" });
  await sessionPool.disposeAll();
  process.exit(0);
}

async function unlockFromLocalTui() {
  const unlockedUntil = await unlockManager.unlockWithoutCode("tui-local");
  console.log(`Local TUI unlock granted until ${new Date(unlockedUntil).toISOString()}`);
  await appendAuditLine({
    time: new Date().toISOString(),
    event: "LOCAL_UNLOCK",
    unlockedUntil: new Date(unlockedUntil).toISOString(),
    unlockedBy: unlockManager.unlockedBy,
  });
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

async function alertOwner(text, fingerprint = "default") {
  const now = Date.now();
  const last = recentAlerts.get(fingerprint) || 0;
  if (now - last < ALERT_DEDUP_WINDOW_MS) return;
  recentAlerts.set(fingerprint, now);

  // Prune stale entries to prevent unbounded memory growth
  if (recentAlerts.size > 100) {
    for (const [key, timestamp] of recentAlerts) {
      if (now - timestamp >= ALERT_DEDUP_WINDOW_MS) recentAlerts.delete(key);
    }
  }

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

function lockStateText() {
  return unlockManager.isLocked()
    ? "locked"
    : `unlocked until ${new Date(unlockManager.unlockedUntil).toISOString()}`;
}

function formatMinutes(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function helpText() {
  return [
    "Available commands:",
    "/status — show lock state",
    "/unlock <code> — unlock temporarily",
    "/lock — lock immediately",
    "/clear — wipe this chat's saved session history",
    "/new — start a fresh session for this chat",
    "/session — show current session details",
    "/compact [instructions] — compact long session context",
    "/name <label> — name the current session",
    "/resume — list saved sessions for this chat",
    "/resume <n|name> — reopen one of those sessions",
    "/help — show this help",
    "",
    "Normal text prompts are forwarded to pi only while unlocked.",
  ].join("\n");
}

function formatSessionInfo(session, stats, chatId) {
  return [
    `Chat: ${chatId}`,
    `Session ID: ${stats.sessionId}`,
    `Name: ${session.sessionName || "(unnamed)"}`,
    `File: ${stats.sessionFile || "(none)"}`,
    `Messages: ${stats.totalMessages} total (${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolCalls} tool calls)`,
    `Tokens: ${stats.tokens.total} total (${stats.tokens.input} in, ${stats.tokens.output} out, ${stats.tokens.cacheRead} cache read, ${stats.tokens.cacheWrite} cache write)`,
    `Cost: ${formatCost(stats.cost)}`,
    `State: ${lockStateText()}`,
  ].join("\n");
}

function formatResumeList(sessions) {
  const lines = ["Saved sessions for this chat:"];
  sessions.slice(0, 12).forEach((entry, index) => {
    lines.push(
      `${index + 1}. ${entry.name || "(unnamed)"} — ${entry.modified.toISOString()} — ${safePreview(entry.firstMessage || "(empty)")}`
    );
  });
  if (sessions.length > 12) {
    lines.push(`…and ${sessions.length - 12} more (only the 12 most recent are listed).`);
  }
  lines.push("", "Use /resume <number> or /resume <name> to reopen one.");
  return lines.join("\n");
}

function formatCost(value) {
  const number = Number(value || 0);
  return `$${number.toFixed(4)}`;
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
    textPreview: redactedPreview(ctx.message?.text || ""),
  };
}

// Never write unlock codes or shared secrets to the audit log.
function redactedPreview(text) {
  if (/^\/unlock(\s|@|$)/i.test(String(text).trim())) return "/unlock <redacted>";
  return safePreview(text);
}
