import blessed from "blessed";
import crypto from "node:crypto";
import os from "node:os";
import QRCode from "qrcode";
import {
  AUDIT_LOG,
  ENV_FILE,
  OUT_LOG,
  PI_AUTH_FILE,
  SHARE_DIR,
  SYSTEMD_LOCAL_FILE,
  SYSTEMD_TEMPLATE_FILE,
  clearLogFile,
  getEffectiveConfig,
  getEnvStatus,
  getStatus,
  readLogTail,
  restartBridge,
  startBridge,
  stopBridge,
  testConfiguration,
  writeEnvConfig,
  writeSystemdService,
} from "./manager-lib.mjs";

const screen = blessed.screen({ smartCSR: true, title: "Telegram Pi Bridge Manager", fullUnicode: true });

const MENU_ITEMS = [
  "First-run config wizard",
  "Edit settings",
  "Regenerate unlock secret",
  "Export TOTP QR",
  "Generate local systemd service",
  "Test configuration",
  "Start bridge",
  "Stop bridge",
  "Restart bridge",
  "Show bridge log",
  "Show audit log",
  "Clear bridge log",
  "Clear audit log",
  "Refresh",
  "Quit",
];

const statusBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 9,
  label: " Status ",
  tags: true,
  border: "line",
  style: { border: { fg: "cyan" } },
  padding: { left: 1, right: 1 },
});

const menu = blessed.list({
  parent: screen,
  top: 9,
  left: 0,
  width: 32,
  height: "100%-13",
  label: " Menu ",
  border: "line",
  keys: true,
  vi: true,
  mouse: true,
  style: { border: { fg: "cyan" }, item: { fg: "white" }, selected: { bg: "blue", fg: "white", bold: true } },
  items: MENU_ITEMS,
});

const outputBox = blessed.box({
  parent: screen,
  top: 9,
  left: 32,
  width: "100%-32",
  height: "100%-13",
  label: " Output ",
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
  mouse: true,
  scrollbar: { ch: " ", track: { bg: "gray" }, style: { bg: "blue" } },
  border: "line",
  style: { border: { fg: "cyan" } },
  padding: { left: 1, right: 1 },
});

const helpBox = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 4,
  label: " Keys ",
  tags: true,
  border: "line",
  style: { border: { fg: "cyan" } },
  padding: { left: 1, right: 1 },
  content:
    "{bold}Enter{/bold} run menu  {bold}w{/bold} wizard  {bold}e{/bold} edit  {bold}g{/bold} gen service  {bold}t{/bold} test  {bold}s{/bold} start  {bold}x{/bold} stop  {bold}r{/bold} restart  {bold}q{/bold} quit",
});

let currentLog = "bridge";
let statusTimer;

menu.focus();
menu.on("select", async (_item, index) => runAction(index));
screen.key(["q", "C-c", "escape"], () => shutdown());
screen.key(["w"], async () => runAction(0));
screen.key(["e"], async () => runAction(1));
screen.key(["g"], async () => runAction(4));
screen.key(["t"], async () => runAction(5));
screen.key(["s"], async () => runAction(6));
screen.key(["x"], async () => runAction(7));
screen.key(["r"], async () => runAction(8));
screen.key(["b"], async () => runAction(9));
screen.key(["a"], async () => runAction(10));
screen.key(["u"], async () => runAction(13));
screen.key(["pageup"], () => { outputBox.scroll(-15); screen.render(); });
screen.key(["pagedown"], () => { outputBox.scroll(15); screen.render(); });

await refreshAll();
statusTimer = setInterval(refreshAll, 2500);

const envStatus = await getEnvStatus();
if (!envStatus.configured) {
  setMessage("Config incomplete. Open the first-run wizard with 'w'.", true);
  outputBox.setContent([
    `Config file: ${ENV_FILE}`,
    "",
    "Detected issues:",
    ...envStatus.issues.map((issue) => `- ${issue}`),
    "",
    "Tip: run the first-run config wizard from the menu.",
  ].join("\n"));
  screen.render();
}

async function runAction(index) {
  try {
    switch (index) {
      case 0: await runWizard(); break;
      case 1: await runSettingsEditor(); break;
      case 2: await regenerateSecret(); break;
      case 3: await exportTotpQr(); break;
      case 4: await generateLocalService(); break;
      case 5: await runConfigurationTest(); break;
      case 6: setMessage((await startBridge()).message); currentLog = "bridge"; break;
      case 7: setMessage((await stopBridge()).message); currentLog = "bridge"; break;
      case 8: setMessage((await restartBridge()).message); currentLog = "bridge"; break;
      case 9: currentLog = "bridge"; setMessage(`Showing ${OUT_LOG}`); break;
      case 10: currentLog = "audit"; setMessage(`Showing ${AUDIT_LOG}`); break;
      case 11: setMessage(await clearLogFile(OUT_LOG)); currentLog = "bridge"; break;
      case 12: setMessage(await clearLogFile(AUDIT_LOG)); currentLog = "audit"; break;
      case 13: setMessage("Refreshed"); break;
      case 14: shutdown(); return;
      default: break;
    }
    await refreshAll();
  } catch (error) {
    setMessage(`Error: ${error.message || String(error)}`, true);
    screen.render();
  }
}

async function refreshAll() {
  const status = await getStatus();
  renderStatus(status);
  await renderLog();
  screen.render();
}

function renderStatus(status) {
  const envLine = status.env.configured
    ? "{green-fg}configured{/green-fg}"
    : `{yellow-fg}needs setup (${status.env.issues.length} issue${status.env.issues.length === 1 ? "" : "s"}){/yellow-fg}`;
  const lines = [
    `{bold}Bridge:{/bold} ${status.running ? "{green-fg}RUNNING{/green-fg}" : "{red-fg}STOPPED{/red-fg}"}`,
    `{bold}PID:{/bold} ${status.pid ?? "-"}`,
    `{bold}Config:{/bold} ${envLine}`,
    `{bold}.env:{/bold} ${ENV_FILE}`,
    `{bold}Local service:{/bold} ${SYSTEMD_LOCAL_FILE}`,
    `{bold}Service template:{/bold} ${SYSTEMD_TEMPLATE_FILE}`,
    `{bold}Bridge log:{/bold} ${status.outLog.path} (${formatBytes(status.outLog.size)})`,
    `{bold}Audit log:{/bold} ${status.auditLog.path} (${formatBytes(status.auditLog.size)})`,
  ];
  statusBox.setContent(lines.join("\n"));
}

async function renderLog() {
  const target = currentLog === "bridge" ? OUT_LOG : AUDIT_LOG;
  const content = await readLogTail(target, 32000);
  outputBox.setLabel(` Output - ${currentLog === "bridge" ? "bridge.out" : "audit.log"} `);
  outputBox.setContent(content || "(empty)");
  outputBox.setScrollPerc(100);
}

function setMessage(message, isError = false) {
  helpBox.setContent(
    `${isError ? "{red-fg}" : "{green-fg}"}${escapeTags(message)}${isError ? "{/red-fg}" : "{/green-fg}"}\n` +
      "{bold}Enter{/bold} run menu  {bold}w{/bold} wizard  {bold}e{/bold} edit  {bold}g{/bold} gen service  {bold}t{/bold} test  {bold}s{/bold} start  {bold}x{/bold} stop  {bold}r{/bold} restart  {bold}q{/bold} quit"
  );
}

async function runWizard() {
  const current = await getEffectiveConfig();
  const botToken = await askText("Telegram bot token", current.TELEGRAM_BOT_TOKEN, { secret: true });
  if (botToken == null) return cancel();
  const ownerId = await askText("Owner Telegram user ID", current.OWNER_TELEGRAM_USER_ID);
  if (ownerId == null) return cancel();
  const ownerChatId = await askText("Owner chat ID (optional)", current.OWNER_CHAT_ID);
  if (ownerChatId == null) return cancel();
  const privateOnly = await askChoice("Private chats only?", ["true", "false"], current.ALLOW_PRIVATE_CHATS_ONLY);
  if (privateOnly == null) return cancel();
  const unlockMethod = await askChoice("Unlock method", ["totp", "secret"], current.UNLOCK_METHOD);
  if (unlockMethod == null) return cancel();

  let totpSecret = current.UNLOCK_TOTP_SECRET;
  let sharedSecret = current.UNLOCK_SHARED_SECRET;
  if (unlockMethod === "totp") {
    totpSecret = await askText("TOTP secret (base32)", totpSecret || generateTotpSecret());
    if (totpSecret == null) return cancel();
  } else {
    sharedSecret = await askText("Shared unlock secret", sharedSecret || generateSharedSecret(), { secret: true });
    if (sharedSecret == null) return cancel();
  }

  const ttl = await askText("Unlock TTL in minutes", current.UNLOCK_TTL_MINUTES);
  if (ttl == null) return cancel();
  const alerts = await askChoice("Alert owner on denied access?", ["true", "false"], current.ALERT_OWNER_ON_DENIED);
  if (alerts == null) return cancel();
  const workspace = await askText("pi workspace directory", current.PI_WORKSPACE_DIR);
  if (workspace == null) return cancel();
  const agentDir = await askText("pi agent directory", current.PI_AGENT_DIR || "~/.pi/agent");
  if (agentDir == null) return cancel();
  const maxTextLength = await askText("Max Telegram text length", current.MAX_TEXT_LENGTH);
  if (maxTextLength == null) return cancel();
  const thinking = await askChoice("pi thinking level", ["off", "low", "medium", "high"], current.PI_THINKING_LEVEL);
  if (thinking == null) return cancel();
  const pinModel = await askChoice("Pin a specific pi model?", ["no", "yes"], current.PI_MODEL_PROVIDER && current.PI_MODEL_NAME ? "yes" : "no");
  if (pinModel == null) return cancel();

  let modelProvider = current.PI_MODEL_PROVIDER;
  let modelName = current.PI_MODEL_NAME;
  if (pinModel === "yes") {
    modelProvider = await askText("pi model provider", modelProvider || "anthropic");
    if (modelProvider == null) return cancel();
    modelName = await askText("pi model name", modelName || "claude-sonnet-4-20250514");
    if (modelName == null) return cancel();
  } else {
    modelProvider = "";
    modelName = "";
  }

  const config = {
    ...current,
    TELEGRAM_BOT_TOKEN: botToken,
    OWNER_TELEGRAM_USER_ID: ownerId,
    OWNER_CHAT_ID: ownerChatId,
    ALLOW_PRIVATE_CHATS_ONLY: privateOnly,
    UNLOCK_METHOD: unlockMethod,
    UNLOCK_TOTP_SECRET: totpSecret,
    UNLOCK_SHARED_SECRET: sharedSecret,
    UNLOCK_TTL_MINUTES: normalizePositiveInt(ttl, 15),
    ALERT_OWNER_ON_DENIED: alerts,
    AUDIT_LOG_FILE: AUDIT_LOG,
    MAX_TEXT_LENGTH: normalizePositiveInt(maxTextLength, 12000),
    PI_WORKSPACE_DIR: workspace,
    PI_AGENT_DIR: agentDir,
    PI_MODEL_PROVIDER: modelProvider,
    PI_MODEL_NAME: modelName,
    PI_THINKING_LEVEL: thinking,
  };

  const confirmed = await askYesNo([
    `Bot token: ${maskValue(config.TELEGRAM_BOT_TOKEN)}`,
    `Owner user ID: ${config.OWNER_TELEGRAM_USER_ID}`,
    `Owner chat ID: ${config.OWNER_CHAT_ID || "(disabled)"}`,
    `Private only: ${config.ALLOW_PRIVATE_CHATS_ONLY}`,
    `Unlock method: ${config.UNLOCK_METHOD}`,
    `Unlock secret: ${maskValue(config.UNLOCK_METHOD === "totp" ? config.UNLOCK_TOTP_SECRET : config.UNLOCK_SHARED_SECRET)}`,
    `TTL: ${config.UNLOCK_TTL_MINUTES} minutes`,
    `Workspace: ${config.PI_WORKSPACE_DIR}`,
    `Agent dir: ${config.PI_AGENT_DIR}`,
    `Thinking: ${config.PI_THINKING_LEVEL}`,
    `Fixed model: ${config.PI_MODEL_PROVIDER && config.PI_MODEL_NAME ? `${config.PI_MODEL_PROVIDER}/${config.PI_MODEL_NAME}` : "(none)"}`,
    "",
    `Write this to ${ENV_FILE}?`,
  ].join("\n"), true);
  if (!confirmed) return cancel();

  await writeEnvConfig(config);
  setMessage(`Saved configuration to ${ENV_FILE}`);
  outputBox.setContent([
    `Saved config to ${ENV_FILE}`,
    "",
    "Suggested next actions:",
    "- Generate local systemd service",
    "- Export TOTP QR (if using totp)",
    "- Start bridge",
  ].join("\n"));
}

async function runSettingsEditor() {
  let config = await getEffectiveConfig();
  while (true) {
    const choice = await askChoice("Edit settings", [
      "Unlock TTL",
      "Unlock method",
      "Private chats only",
      "Alert owner on denied",
      "Owner Telegram user ID",
      "Owner chat ID",
      "Max text length",
      "pi workspace directory",
      "pi agent directory",
      "Thinking level",
      "Fixed model",
      "Audit log path",
      "Back",
    ], "Unlock TTL");
    if (!choice || choice === "Back") break;

    if (choice === "Unlock TTL") {
      const value = await askText("Unlock TTL in minutes", String(config.UNLOCK_TTL_MINUTES));
      if (value != null) config.UNLOCK_TTL_MINUTES = normalizePositiveInt(value, 15);
    } else if (choice === "Unlock method") {
      const value = await askChoice("Unlock method", ["totp", "secret"], config.UNLOCK_METHOD);
      if (value) config.UNLOCK_METHOD = value;
    } else if (choice === "Private chats only") {
      const value = await askChoice("Private chats only", ["true", "false"], config.ALLOW_PRIVATE_CHATS_ONLY);
      if (value) config.ALLOW_PRIVATE_CHATS_ONLY = value;
    } else if (choice === "Alert owner on denied") {
      const value = await askChoice("Alert owner on denied", ["true", "false"], config.ALERT_OWNER_ON_DENIED);
      if (value) config.ALERT_OWNER_ON_DENIED = value;
    } else if (choice === "Owner Telegram user ID") {
      const value = await askText("Owner Telegram user ID", config.OWNER_TELEGRAM_USER_ID);
      if (value != null) config.OWNER_TELEGRAM_USER_ID = value;
    } else if (choice === "Owner chat ID") {
      const value = await askText("Owner chat ID (optional)", config.OWNER_CHAT_ID);
      if (value != null) config.OWNER_CHAT_ID = value;
    } else if (choice === "Max text length") {
      const value = await askText("Max Telegram text length", String(config.MAX_TEXT_LENGTH));
      if (value != null) config.MAX_TEXT_LENGTH = normalizePositiveInt(value, 12000);
    } else if (choice === "pi workspace directory") {
      const value = await askText("pi workspace directory", config.PI_WORKSPACE_DIR);
      if (value != null) config.PI_WORKSPACE_DIR = value;
    } else if (choice === "pi agent directory") {
      const value = await askText("pi agent directory", config.PI_AGENT_DIR);
      if (value != null) config.PI_AGENT_DIR = value;
    } else if (choice === "Thinking level") {
      const value = await askChoice("Thinking level", ["off", "low", "medium", "high"], config.PI_THINKING_LEVEL);
      if (value) config.PI_THINKING_LEVEL = value;
    } else if (choice === "Fixed model") {
      const enabled = await askChoice("Fixed model", ["disabled", "enabled"], config.PI_MODEL_PROVIDER && config.PI_MODEL_NAME ? "enabled" : "disabled");
      if (enabled === "disabled") {
        config.PI_MODEL_PROVIDER = "";
        config.PI_MODEL_NAME = "";
      } else if (enabled === "enabled") {
        const provider = await askText("pi model provider", config.PI_MODEL_PROVIDER || "anthropic");
        if (provider == null) continue;
        const model = await askText("pi model name", config.PI_MODEL_NAME || "claude-sonnet-4-20250514");
        if (model == null) continue;
        config.PI_MODEL_PROVIDER = provider;
        config.PI_MODEL_NAME = model;
      }
    } else if (choice === "Audit log path") {
      const value = await askText("Audit log path", config.AUDIT_LOG_FILE || AUDIT_LOG);
      if (value != null) config.AUDIT_LOG_FILE = value;
    }

    if (config.UNLOCK_METHOD === "totp" && !config.UNLOCK_TOTP_SECRET) config.UNLOCK_TOTP_SECRET = generateTotpSecret();
    if (config.UNLOCK_METHOD === "secret" && !config.UNLOCK_SHARED_SECRET) config.UNLOCK_SHARED_SECRET = generateSharedSecret();

    await writeEnvConfig(config);
    setMessage(`Saved setting: ${choice}`);
  }
}

async function regenerateSecret() {
  const config = await getEffectiveConfig();
  const which = await askChoice("Regenerate unlock secret", ["totp secret", "shared secret", "cancel"], "totp secret");
  if (!which || which === "cancel") return cancel();
  if (which === "totp secret") {
    config.UNLOCK_METHOD = "totp";
    config.UNLOCK_TOTP_SECRET = generateTotpSecret();
    await writeEnvConfig(config);
    setMessage("Generated new TOTP secret and saved .env");
    outputBox.setContent(`New TOTP secret:\n\n${config.UNLOCK_TOTP_SECRET}\n\nUse Export TOTP QR to create a QR image.`);
  } else {
    config.UNLOCK_METHOD = "secret";
    config.UNLOCK_SHARED_SECRET = generateSharedSecret();
    await writeEnvConfig(config);
    setMessage("Generated new shared secret and saved .env");
    outputBox.setContent(`New shared secret:\n\n${config.UNLOCK_SHARED_SECRET}`);
  }
}

async function exportTotpQr() {
  const config = await getEffectiveConfig();
  if (config.UNLOCK_METHOD !== "totp" || !config.UNLOCK_TOTP_SECRET) {
    setMessage("Current config is not using TOTP", true);
    return;
  }
  await ensureShareDir();
  const issuer = "Telegram Pi Bridge";
  const account = "telegram-pi-bridge";
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${config.UNLOCK_TOTP_SECRET}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  const pngPath = `${SHARE_DIR}/totp-qr.png`;
  const txtPath = `${SHARE_DIR}/totp-uri.txt`;
  await QRCode.toFile(pngPath, uri, { type: "png", width: 512, margin: 2 });
  await import("node:fs/promises").then((fs) => fs.writeFile(txtPath, `${uri}\n`, "utf8"));
  setMessage(`Exported TOTP QR to ${pngPath}`);
  outputBox.setContent([`QR image: ${pngPath}`, `OTP URI: ${txtPath}`, "", uri].join("\n"));
}

async function generateLocalService() {
  const config = await getEffectiveConfig();
  const serviceUser = await askText("systemd User=", os.userInfo().username);
  if (serviceUser == null) return cancel();
  const installPath = await askText("systemd WorkingDirectory", config.PI_WORKSPACE_DIR || process.cwd());
  if (installPath == null) return cancel();
  const service = await writeSystemdService({ installPath, user: serviceUser });
  setMessage(`Generated local service: ${service.path}`);
  outputBox.setContent([
    `Local service file: ${service.path}`,
    `Public example template: ${SYSTEMD_TEMPLATE_FILE}`,
    "",
    `To install system-wide:`,
    `sudo cp ${service.path} /etc/systemd/system/telegram-pi-bridge.service`,
    `sudo systemctl daemon-reload`,
    `sudo systemctl enable --now telegram-pi-bridge`,
  ].join("\n"));
}

async function runConfigurationTest() {
  const checks = await testConfiguration();
  const lines = checks.map((check) => `${check.ok ? "[OK]" : "[WARN]"} ${check.name} — ${check.details}`);
  setMessage(checks.every((c) => c.ok) ? "Configuration test passed" : "Configuration test found issues", !checks.every((c) => c.ok));
  outputBox.setContent(lines.join("\n"));
}

async function askText(label, initial = "", _options = {}) {
  return new Promise((resolve) => {
    const prompt = blessed.prompt({
      parent: screen,
      border: "line",
      height: 9,
      width: "80%",
      top: "center",
      left: "center",
      label: ` ${label} `,
      tags: true,
      keys: true,
      vi: true,
      style: { border: { fg: "green" }, fg: "white", bg: "black" },
    });
    prompt.input(label, String(initial ?? ""), (_err, value) => {
      prompt.destroy();
      screen.render();
      if (typeof value !== "string") return resolve(null);
      resolve(value.trim());
    });
    screen.render();
  });
}

async function askChoice(label, options, current) {
  return new Promise((resolve) => {
    const list = blessed.list({
      parent: screen,
      border: "line",
      label: ` ${label} `,
      width: 48,
      height: Math.min(options.length + 4, 16),
      top: "center",
      left: "center",
      keys: true,
      vi: true,
      mouse: true,
      items: options,
      style: { border: { fg: "green" }, selected: { bg: "blue", bold: true } },
    });
    const initialIndex = Math.max(0, options.indexOf(current));
    list.select(initialIndex);
    list.focus();
    screen.render();
    const finish = (value) => { list.destroy(); screen.render(); resolve(value); };
    list.key(["enter"], () => finish(list.getItem(list.selected).content));
    list.key(["escape", "q"], () => finish(null));
  });
}

async function askYesNo(message, defaultYes = true) {
  return new Promise((resolve) => {
    const question = blessed.question({
      parent: screen,
      border: "line",
      width: "80%",
      height: 12,
      top: "center",
      left: "center",
      label: " Confirm ",
      tags: true,
      keys: true,
      vi: true,
      style: { border: { fg: "green" } },
    });
    question.ask(`${escapeTags(message)}\n\n${defaultYes ? "[Y/n]" : "[y/N]"}`, (value) => {
      question.destroy();
      screen.render();
      resolve(Boolean(value));
    });
    screen.render();
  });
}

function generateSharedSecret() {
  return crypto.randomBytes(24).toString("hex");
}

function generateTotpSecret() {
  return toBase32(crypto.randomBytes(20));
}

function toBase32(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i < bits.length; i += 5) output += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return output;
}

function maskValue(value) {
  const text = String(value || "");
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? String(Math.floor(parsed)) : String(fallback);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function escapeTags(value) {
  return String(value).replace(/[{}]/g, "");
}

function cancel() {
  setMessage("Operation cancelled", true);
}

async function ensureShareDir() {
  await import("node:fs/promises").then((fs) => fs.mkdir(SHARE_DIR, { recursive: true }));
}

function shutdown() {
  if (statusTimer) clearInterval(statusTimer);
  screen.destroy();
  process.exit(0);
}
