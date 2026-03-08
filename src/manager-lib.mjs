import { mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUN_DIR = path.join(BASE_DIR, "run");
export const LOG_DIR = path.join(BASE_DIR, "logs");
export const SHARE_DIR = path.join(BASE_DIR, "share");
export const PID_FILE = path.join(RUN_DIR, "bridge.pid");
export const OUT_LOG = path.join(BASE_DIR, "bridge.out");
export const AUDIT_LOG = path.join(LOG_DIR, "audit.log");
export const ENTRYPOINT = path.join(BASE_DIR, "src", "index.mjs");
export const ENV_FILE = path.join(BASE_DIR, ".env");
export const ENV_EXAMPLE_FILE = path.join(BASE_DIR, ".env.example");
export const SYSTEMD_DIR = path.join(BASE_DIR, "systemd");
export const SYSTEMD_LOCAL_FILE = path.join(SYSTEMD_DIR, "telegram-pi-bridge.service");
export const SYSTEMD_TEMPLATE_FILE = path.join(SYSTEMD_DIR, "telegram-pi-bridge.service.example");
export const PI_AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
const execFileAsync = promisify(execFile);

export async function ensureRuntimeDirs() {
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(SHARE_DIR, { recursive: true });
}

export async function getPid() {
  try {
    const raw = await readFile(PID_FILE, "utf8");
    const pid = Number(raw.trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function isPidRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getStatus() {
  let pid = await getPid();
  let running = pid != null && isPidRunning(pid);

  if (!running) {
    const discoveredPid = await findBridgePid();
    if (discoveredPid) {
      pid = discoveredPid;
      running = true;
      await ensureRuntimeDirs();
      await writeFile(PID_FILE, `${pid}\n`, "utf8");
    }
  }

  const outLogStat = await safeStat(OUT_LOG);
  const auditLogStat = await safeStat(AUDIT_LOG);
  const envStatus = await getEnvStatus();
  return {
    pid,
    running,
    pidFile: PID_FILE,
    outLog: {
      path: OUT_LOG,
      exists: Boolean(outLogStat),
      size: outLogStat?.size ?? 0,
      mtimeMs: outLogStat?.mtimeMs ?? 0,
    },
    auditLog: {
      path: AUDIT_LOG,
      exists: Boolean(auditLogStat),
      size: auditLogStat?.size ?? 0,
      mtimeMs: auditLogStat?.mtimeMs ?? 0,
    },
    env: envStatus,
  };
}

export async function startBridge() {
  await ensureRuntimeDirs();
  const current = await getStatus();
  if (current.running) {
    return { changed: false, status: current, message: `Bridge already running (pid ${current.pid})` };
  }

  const stdoutFd = await open(OUT_LOG, "a");
  const stderrFd = await open(OUT_LOG, "a");

  try {
    const child = spawn(process.execPath, [ENTRYPOINT], {
      cwd: BASE_DIR,
      detached: true,
      stdio: ["ignore", stdoutFd.fd, stderrFd.fd],
      env: process.env,
    });
    child.unref();
    await writeFile(PID_FILE, `${child.pid}\n`, "utf8");
    await sleep(1200);
    const status = await getStatus();
    return {
      changed: true,
      status,
      message: status.running
        ? `Bridge started (pid ${status.pid})`
        : `Bridge launched but is not running; check ${OUT_LOG}`,
    };
  } finally {
    await stdoutFd.close();
    await stderrFd.close();
  }
}

export async function stopBridge() {
  const pid = await getPid();
  if (!pid || !isPidRunning(pid)) {
    await rm(PID_FILE, { force: true });
    return { changed: false, status: await getStatus(), message: "Bridge is not running" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore and fall through to cleanup
  }

  const stopped = await waitForExit(pid, 5000);
  if (!stopped) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
    await waitForExit(pid, 1500);
  }

  await rm(PID_FILE, { force: true });
  const status = await getStatus();
  return { changed: true, status, message: `Bridge stopped (pid ${pid})` };
}

export async function restartBridge() {
  const stopped = await stopBridge();
  const started = await startBridge();
  return {
    changed: stopped.changed || started.changed,
    status: started.status,
    message: `${stopped.message}; ${started.message}`,
  };
}

export async function readLogTail(logPath, maxBytes = 24000) {
  try {
    const file = await readFile(logPath, "utf8");
    if (file.length <= maxBytes) return file;
    return file.slice(-maxBytes);
  } catch (error) {
    return `[missing] ${logPath}\n${error.message || String(error)}`;
  }
}

export async function clearLogFile(logPath) {
  try {
    await truncate(logPath, 0);
    return `Cleared ${logPath}`;
  } catch (error) {
    return `Could not clear ${logPath}: ${error.message || String(error)}`;
  }
}

export async function getEnvStatus() {
  const fileStat = await safeStat(ENV_FILE);
  if (!fileStat) {
    return { exists: false, configured: false, issues: [".env is missing"], values: {} };
  }

  const env = await readEnvFile();
  const issues = [];

  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN === "123456789:replace_me") {
    issues.push("TELEGRAM_BOT_TOKEN is missing or placeholder");
  }
  if (!env.OWNER_TELEGRAM_USER_ID || env.OWNER_TELEGRAM_USER_ID === "123456789") {
    issues.push("OWNER_TELEGRAM_USER_ID is missing or placeholder");
  }
  if (!env.UNLOCK_METHOD) {
    issues.push("UNLOCK_METHOD is missing");
  } else if (env.UNLOCK_METHOD === "totp") {
    if (!env.UNLOCK_TOTP_SECRET || env.UNLOCK_TOTP_SECRET === "JBSWY3DPEHPK3PXP") {
      issues.push("UNLOCK_TOTP_SECRET is missing or example value");
    }
  } else if (env.UNLOCK_METHOD === "secret") {
    if (!env.UNLOCK_SHARED_SECRET || env.UNLOCK_SHARED_SECRET.startsWith("replace_")) {
      issues.push("UNLOCK_SHARED_SECRET is missing or placeholder");
    }
  } else {
    issues.push("UNLOCK_METHOD must be 'totp' or 'secret'");
  }

  return {
    exists: true,
    configured: issues.length === 0,
    issues,
    values: env,
  };
}

export async function readEnvFile() {
  const raw = await readFile(ENV_FILE, "utf8");
  return parseEnv(raw);
}

export async function getEffectiveConfig() {
  const envStatus = await getEnvStatus();
  const env = envStatus.values || {};
  return {
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || "",
    OWNER_TELEGRAM_USER_ID: env.OWNER_TELEGRAM_USER_ID || "",
    OWNER_CHAT_ID: env.OWNER_CHAT_ID || "",
    ALLOW_PRIVATE_CHATS_ONLY: env.ALLOW_PRIVATE_CHATS_ONLY || "true",
    UNLOCK_METHOD: env.UNLOCK_METHOD || "totp",
    UNLOCK_TOTP_SECRET: env.UNLOCK_TOTP_SECRET || "",
    UNLOCK_SHARED_SECRET: env.UNLOCK_SHARED_SECRET || "",
    UNLOCK_TTL_MINUTES: env.UNLOCK_TTL_MINUTES || "15",
    UNLOCK_STATE_FILE: env.UNLOCK_STATE_FILE || path.join(BASE_DIR, "data", "unlock-state.json"),
    ALERT_OWNER_ON_DENIED: env.ALERT_OWNER_ON_DENIED || "true",
    AUDIT_LOG_FILE: env.AUDIT_LOG_FILE || AUDIT_LOG,
    MAX_TEXT_LENGTH: env.MAX_TEXT_LENGTH || "12000",
    PI_WORKSPACE_DIR: env.PI_WORKSPACE_DIR || process.cwd(),
    PI_AGENT_DIR: env.PI_AGENT_DIR || "~/.pi/agent",
    PI_MODEL_PROVIDER: env.PI_MODEL_PROVIDER || "",
    PI_MODEL_NAME: env.PI_MODEL_NAME || "",
    PI_THINKING_LEVEL: env.PI_THINKING_LEVEL || "medium",
  };
}

export async function writeEnvConfig(config) {
  const lines = [
    `TELEGRAM_BOT_TOKEN=${config.TELEGRAM_BOT_TOKEN}`,
    `OWNER_TELEGRAM_USER_ID=${config.OWNER_TELEGRAM_USER_ID}`,
    config.OWNER_CHAT_ID ? `OWNER_CHAT_ID=${config.OWNER_CHAT_ID}` : `# OWNER_CHAT_ID=123456789`,
    `ALLOW_PRIVATE_CHATS_ONLY=${config.ALLOW_PRIVATE_CHATS_ONLY}`,
    `UNLOCK_METHOD=${config.UNLOCK_METHOD}`,
  ];

  if (config.UNLOCK_METHOD === "totp") {
    lines.push(`UNLOCK_TOTP_SECRET=${config.UNLOCK_TOTP_SECRET}`);
    lines.push(`# UNLOCK_SHARED_SECRET=replace_with_long_random_secret`);
  } else {
    lines.push(`# UNLOCK_TOTP_SECRET=JBSWY3DPEHPK3PXP`);
    lines.push(`UNLOCK_SHARED_SECRET=${config.UNLOCK_SHARED_SECRET}`);
  }

  lines.push(
    `UNLOCK_TTL_MINUTES=${config.UNLOCK_TTL_MINUTES}`,
    config.UNLOCK_STATE_FILE ? `UNLOCK_STATE_FILE=${config.UNLOCK_STATE_FILE}` : `# UNLOCK_STATE_FILE=${path.join(BASE_DIR, "data", "unlock-state.json")}`,
    `ALERT_OWNER_ON_DENIED=${config.ALERT_OWNER_ON_DENIED}`,
    `AUDIT_LOG_FILE=${config.AUDIT_LOG_FILE || AUDIT_LOG}`,
    `MAX_TEXT_LENGTH=${config.MAX_TEXT_LENGTH}`,
    `PI_WORKSPACE_DIR=${config.PI_WORKSPACE_DIR}`,
    `PI_AGENT_DIR=${config.PI_AGENT_DIR}`,
    config.PI_MODEL_PROVIDER ? `PI_MODEL_PROVIDER=${config.PI_MODEL_PROVIDER}` : `# PI_MODEL_PROVIDER=anthropic`,
    config.PI_MODEL_NAME ? `PI_MODEL_NAME=${config.PI_MODEL_NAME}` : `# PI_MODEL_NAME=claude-sonnet-4-20250514`,
    `PI_THINKING_LEVEL=${config.PI_THINKING_LEVEL}`,
    ""
  );

  await writeFile(ENV_FILE, `${lines.join("\n")}\n`, "utf8");
}

export async function writeSystemdService({ installPath, user }) {
  const workingDirectory = installPath || process.cwd();
  const serviceUser = user || "youruser";
  const content = renderSystemdService({ workingDirectory, user: serviceUser });
  await mkdir(SYSTEMD_DIR, { recursive: true });
  await writeFile(SYSTEMD_LOCAL_FILE, content, "utf8");
  return { path: SYSTEMD_LOCAL_FILE, content };
}

export async function triggerLocalUnlock() {
  const pid = await getPid();
  if (!pid || !isPidRunning(pid)) {
    throw new Error("Bridge is not running");
  }

  process.kill(pid, "SIGUSR1");

  const config = await getEffectiveConfig();
  const ttlMinutes = Math.max(1, Number(config.UNLOCK_TTL_MINUTES || 15));
  return {
    pid,
    ttlMinutes,
    unlockedUntil: Date.now() + ttlMinutes * 60_000,
  };
}

export function renderSystemdService({ workingDirectory, user }) {
  const safeDir = workingDirectory || "/opt/telegram-pi-bridge";
  const safeUser = user || "youruser";
  return `[Unit]\nDescription=Telegram Pi Bridge\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${safeUser}\nWorkingDirectory=${safeDir}\nEnvironmentFile=${safeDir}/.env\nExecStart=/usr/bin/npm start\nRestart=always\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\nProtectControlGroups=true\nProtectKernelTunables=true\nProtectKernelModules=true\nLockPersonality=true\nRestrictSUIDSGID=true\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export async function testConfiguration() {
  const envStatus = await getEnvStatus();
  const checks = [];
  checks.push({ name: ".env file", ok: envStatus.exists, details: ENV_FILE });
  checks.push({ name: "Config completeness", ok: envStatus.configured, details: envStatus.issues.join("; ") || "ok" });
  const piAuth = await safeStat(PI_AUTH_FILE);
  checks.push({ name: "pi auth", ok: Boolean(piAuth), details: PI_AUTH_FILE });
  const localService = await safeStat(SYSTEMD_LOCAL_FILE);
  checks.push({ name: "Local systemd service", ok: Boolean(localService), details: SYSTEMD_LOCAL_FILE });
  const templateService = await safeStat(SYSTEMD_TEMPLATE_FILE);
  checks.push({ name: "Service example template", ok: Boolean(templateService), details: SYSTEMD_TEMPLATE_FILE });
  return checks;
}

function parseEnv(raw) {
  const result = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

async function safeStat(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

async function findBridgePid() {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
    const lines = stdout.split("\n");
    let fallbackPid = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const [, pidText, args] = match;
      const pid = Number(pidText);
      if (!Number.isFinite(pid) || pid === process.pid || !isPidRunning(pid)) continue;

      if (args.includes(ENTRYPOINT) || args.includes("node src/index.mjs")) {
        if (!args.includes("sh -c node src/index.mjs")) return pid;
        fallbackPid = fallbackPid ?? pid;
      }
    }
    return fallbackPid;
  } catch {
    return null;
  }
}

async function waitForExit(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isPidRunning(pid)) return true;
    await sleep(150);
  }
  return !isPidRunning(pid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
