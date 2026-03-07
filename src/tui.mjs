import blessed from "blessed";
import crypto from "node:crypto";
import os from "node:os";
import {
  AUDIT_LOG,
  ENV_FILE,
  OUT_LOG,
  SYSTEMD_LOCAL_FILE,
  SYSTEMD_TEMPLATE_FILE,
  getEnvStatus,
  getStatus,
  readLogTail,
  restartBridge,
  startBridge,
  stopBridge,
  writeEnvConfig,
  writeSystemdService,
} from "./manager-lib.mjs";

const screen = blessed.screen({
  smartCSR: true,
  title: "Telegram Pi Bridge Manager",
  fullUnicode: true,
});

const statusBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 8,
  label: " Status ",
  tags: true,
  border: "line",
  style: { border: { fg: "cyan" } },
  padding: { left: 1, right: 1 },
});

const menu = blessed.list({
  parent: screen,
  top: 8,
  left: 0,
  width: 30,
  height: "100%-12",
  label: " Menu ",
  border: "line",
  keys: true,
  vi: true,
  mouse: true,
  style: {
    border: { fg: "cyan" },
    item: { fg: "white" },
    selected: { bg: "blue", fg: "white", bold: true },
  },
  items: [
    "First-run config wizard",
    "Start bridge",
    "Stop bridge",
    "Restart bridge",
    "Show bridge log",
    "Show audit log",
    "Refresh",
    "Quit",
  ],
});

const outputBox = blessed.box({
  parent: screen,
  top: 8,
  left: 30,
  width: "100%-30",
  height: "100%-12",
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
    "{bold}Enter{/bold} run menu  {bold}w{/bold} wizard  {bold}s{/bold} start  {bold}x{/bold} stop  {bold}r{/bold} restart  {bold}b{/bold} bridge log  {bold}a{/bold} audit log  {bold}u{/bold} refresh  {bold}q{/bold} quit",
});

let currentLog = "bridge";
let statusTimer;

menu.focus();
menu.on("select", async (_item, index) => {
  await runAction(index);
});

screen.key(["q", "C-c", "escape"], () => shutdown());
screen.key(["w"], async () => runAction(0));
screen.key(["s"], async () => runAction(1));
screen.key(["x"], async () => runAction(2));
screen.key(["r"], async () => runAction(3));
screen.key(["b"], async () => runAction(4));
screen.key(["a"], async () => runAction(5));
screen.key(["u"], async () => runAction(6));
screen.key(["pageup"], () => {
  outputBox.scroll(-15);
  screen.render();
});
screen.key(["pagedown"], () => {
  outputBox.scroll(15);
  screen.render();
});

await refreshAll();
statusTimer = setInterval(refreshAll, 2500);

const envStatus = await getEnvStatus();
if (!envStatus.configured) {
  setMessage("Config incomplete. Open the first-run wizard with 'w' or the menu.", true);
  outputBox.setContent(
    [
      `Config file: ${ENV_FILE}`,
      "",
      "Detected issues:",
      ...envStatus.issues.map((issue) => `- ${issue}`),
      "",
      "Tip: run the first-run config wizard from the menu.",
    ].join("\n")
  );
  screen.render();
}

async function runAction(index) {
  try {
    switch (index) {
      case 0:
        await runWizard();
        currentLog = "bridge";
        break;
      case 1:
        setMessage((await startBridge()).message);
        currentLog = "bridge";
        break;
      case 2:
        setMessage((await stopBridge()).message);
        currentLog = "bridge";
        break;
      case 3:
        setMessage((await restartBridge()).message);
        currentLog = "bridge";
        break;
      case 4:
        currentLog = "bridge";
        setMessage(`Showing ${OUT_LOG}`);
        break;
      case 5:
        currentLog = "audit";
        setMessage(`Showing ${AUDIT_LOG}`);
        break;
      case 6:
        setMessage("Refreshed");
        break;
      case 7:
        shutdown();
        return;
      default:
        break;
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
    `{bold}Bridge log:{/bold} ${status.outLog.path} (${formatBytes(status.outLog.size)})`,
    `{bold}Audit log:{/bold} ${status.auditLog.path} (${formatBytes(status.auditLog.size)})`,
    `{bold}View:{/bold} ${currentLog === "bridge" ? "bridge.out" : "audit.log"}`,
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
      "{bold}Enter{/bold} run menu  {bold}w{/bold} wizard  {bold}s{/bold} start  {bold}x{/bold} stop  {bold}r{/bold} restart  {bold}b{/bold} bridge log  {bold}a{/bold} audit log  {bold}u{/bold} refresh  {bold}q{/bold} quit"
  );
}

async function runWizard() {
  const status = await getEnvStatus();
  const current = status.values || {};

  setMessage("Running first-run configuration wizard...");
  screen.render();

  const botToken = await askText(
    "Telegram bot token",
    current.TELEGRAM_BOT_TOKEN && current.TELEGRAM_BOT_TOKEN !== "123456789:replace_me"
      ? current.TELEGRAM_BOT_TOKEN
      : "",
    { secret: true }
  );
  if (botToken == null) return setMessage("Wizard cancelled", true);

  const ownerId = await askText(
    "Owner Telegram user ID",
    current.OWNER_TELEGRAM_USER_ID && current.OWNER_TELEGRAM_USER_ID !== "123456789"
      ? current.OWNER_TELEGRAM_USER_ID
      : ""
  );
  if (ownerId == null) return setMessage("Wizard cancelled", true);

  const ownerChatId = await askText(
    "Owner chat ID (optional, leave blank to disable)",
    current.OWNER_CHAT_ID || ""
  );
  if (ownerChatId == null) return setMessage("Wizard cancelled", true);

  const privateOnly = await askChoice("Private chats only?", ["true", "false"], current.ALLOW_PRIVATE_CHATS_ONLY || "true");
  if (privateOnly == null) return setMessage("Wizard cancelled", true);

  const unlockMethod = await askChoice(
    "Unlock method",
    ["totp", "secret"],
    current.UNLOCK_METHOD || "totp"
  );
  if (unlockMethod == null) return setMessage("Wizard cancelled", true);

  let totpSecret = current.UNLOCK_TOTP_SECRET || "";
  let sharedSecret = current.UNLOCK_SHARED_SECRET || "";

  if (unlockMethod === "totp") {
    const generated = current.UNLOCK_TOTP_SECRET && current.UNLOCK_TOTP_SECRET !== "JBSWY3DPEHPK3PXP"
      ? current.UNLOCK_TOTP_SECRET
      : generateTotpSecret();
    totpSecret = await askText("TOTP secret (base32)", generated);
    if (totpSecret == null) return setMessage("Wizard cancelled", true);
  } else {
    const generated = current.UNLOCK_SHARED_SECRET && !current.UNLOCK_SHARED_SECRET.startsWith("replace_")
      ? current.UNLOCK_SHARED_SECRET
      : generateSharedSecret();
    sharedSecret = await askText("Shared unlock secret", generated, { secret: true });
    if (sharedSecret == null) return setMessage("Wizard cancelled", true);
  }

  const ttl = await askText("Unlock TTL in minutes", current.UNLOCK_TTL_MINUTES || "15");
  if (ttl == null) return setMessage("Wizard cancelled", true);

  const alerts = await askChoice(
    "Alert owner on denied access?",
    ["true", "false"],
    current.ALERT_OWNER_ON_DENIED || "true"
  );
  if (alerts == null) return setMessage("Wizard cancelled", true);

  const workspace = await askText("pi workspace directory", current.PI_WORKSPACE_DIR || process.cwd());
  if (workspace == null) return setMessage("Wizard cancelled", true);

  const agentDir = await askText("pi agent directory", current.PI_AGENT_DIR || "~/.pi/agent");
  if (agentDir == null) return setMessage("Wizard cancelled", true);

  const maxTextLength = await askText("Max Telegram text length", current.MAX_TEXT_LENGTH || "12000");
  if (maxTextLength == null) return setMessage("Wizard cancelled", true);

  const thinking = await askChoice(
    "pi thinking level",
    ["off", "low", "medium", "high"],
    current.PI_THINKING_LEVEL || "medium"
  );
  if (thinking == null) return setMessage("Wizard cancelled", true);

  const pinModel = await askChoice(
    "Pin a specific pi model?",
    ["no", "yes"],
    current.PI_MODEL_PROVIDER && current.PI_MODEL_NAME ? "yes" : "no"
  );
  if (pinModel == null) return setMessage("Wizard cancelled", true);

  let modelProvider = "";
  let modelName = "";
  if (pinModel === "yes") {
    modelProvider = await askText("pi model provider", current.PI_MODEL_PROVIDER || "anthropic");
    if (modelProvider == null) return setMessage("Wizard cancelled", true);
    modelName = await askText("pi model name", current.PI_MODEL_NAME || "claude-sonnet-4-20250514");
    if (modelName == null) return setMessage("Wizard cancelled", true);
  }

  const summary = [
    `Bot token: ${maskValue(botToken)}`,
    `Owner user ID: ${ownerId}`,
    `Owner chat ID: ${ownerChatId || "(disabled)"}`,
    `Private only: ${privateOnly}`,
    `Unlock method: ${unlockMethod}`,
    `Unlock secret: ${unlockMethod === "totp" ? maskValue(totpSecret) : maskValue(sharedSecret)}`,
    `TTL: ${ttl} minutes`,
    `Alerts: ${alerts}`,
    `Workspace: ${workspace}`,
    `pi agent dir: ${agentDir}`,
    `Max text length: ${maxTextLength}`,
    `Thinking: ${thinking}`,
    `Fixed model: ${pinModel === "yes" ? `${modelProvider}/${modelName}` : "(none)"}`,
    "",
    `Write this to ${ENV_FILE}?`,
  ].join("\n");

  const confirmed = await askYesNo(summary, true);
  if (!confirmed) {
    setMessage("Wizard cancelled", true);
    return;
  }

  await writeEnvConfig({
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
    PI_MODEL_PROVIDER: pinModel === "yes" ? modelProvider : "",
    PI_MODEL_NAME: pinModel === "yes" ? modelName : "",
    PI_THINKING_LEVEL: thinking,
  });

  let serviceNote = "- No systemd example generated";
  const createService = await askChoice(
    "Also generate a local systemd service example?",
    ["yes", "no"],
    "yes"
  );
  if (createService == null) return setMessage("Wizard cancelled", true);

  if (createService === "yes") {
    const serviceUser = await askText("systemd User=", os.userInfo().username);
    if (serviceUser == null) return setMessage("Wizard cancelled", true);
    const installPath = await askText("systemd WorkingDirectory", process.cwd());
    if (installPath == null) return setMessage("Wizard cancelled", true);
    const service = await writeSystemdService({ installPath, user: serviceUser });
    serviceNote = `- Wrote local systemd service to ${service.path}`;
  }

  setMessage(`Saved configuration to ${ENV_FILE}`);
  currentLog = "bridge";
  outputBox.setContent(
    [
      `Saved config to ${ENV_FILE}`,
      serviceNote,
      createService === "yes"
        ? `- If wanted, copy ${SYSTEMD_LOCAL_FILE} to /etc/systemd/system/telegram-pi-bridge.service`
        : "",
      `- Public example template lives at ${SYSTEMD_TEMPLATE_FILE}`,
      "",
      "Next steps:",
      "- Start the bridge from this TUI",
      "- Open a private chat with your bot",
      "- Use /unlock <code> to unlock it",
      unlockMethod === "totp"
        ? `- Add the TOTP secret to your authenticator app: ${totpSecret}`
        : "- Keep your shared unlock secret somewhere safe",
    ].filter(Boolean).join("\n")
  );
  screen.render();
}

async function askText(label, initial = "", options = {}) {
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
      style: {
        border: { fg: "green" },
        fg: "white",
        bg: "black",
      },
    });

    const askLabel = options.secret ? `${label} (input hidden in summary only)` : label;
    prompt.input(askLabel, initial, (_err, value) => {
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
      width: 42,
      height: Math.min(options.length + 4, 10),
      top: "center",
      left: "center",
      keys: true,
      vi: true,
      mouse: true,
      items: options,
      style: {
        border: { fg: "green" },
        selected: { bg: "blue", bold: true },
      },
    });

    const initialIndex = Math.max(0, options.indexOf(current));
    list.select(initialIndex);
    list.focus();
    screen.render();

    const finish = (value) => {
      list.destroy();
      screen.render();
      resolve(value);
    };

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
      style: {
        border: { fg: "green" },
      },
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
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    output += alphabet[Number.parseInt(chunk, 2)];
  }
  return output;
}

function maskValue(value) {
  const text = String(value || "");
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function escapeTags(value) {
  return String(value).replace(/[{}]/g, "");
}

function shutdown() {
  if (statusTimer) clearInterval(statusTimer);
  screen.destroy();
  process.exit(0);
}
