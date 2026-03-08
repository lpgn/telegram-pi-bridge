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
  triggerLocalUnlock,
  writeEnvConfig,
  writeSystemdService,
} from "./manager-lib.mjs";

const screen = blessed.screen({ smartCSR: true, title: "Telegram Pi Bridge Manager", fullUnicode: true });

const MENUS = {
  main: {
    title: " Main Menu ",
    items: ["Setup", "Bridge", "Logs", "Refresh", "Quit"],
  },
  setup: {
    title: " Setup ",
    items: [
      "First-run config wizard",
      "Edit settings",
      "Regenerate unlock secret",
      "Export TOTP QR",
      "Generate local systemd service",
      "Test configuration",
      "Back",
    ],
  },
  bridge: {
    title: " Bridge ",
    items: [
      "Status",
      "Start Telegram bridge process",
      "Stop Telegram bridge process",
      "Restart Telegram bridge process",
      "Temporarily unlock from local TUI",
      "Show Telegram command reference",
      "Back",
    ],
  },
  logs: {
    title: " Logs ",
    items: ["Show bridge log", "Show audit log", "Clear bridge log", "Clear audit log", "Back"],
  },
};

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
  label: MENUS.main.title,
  border: "line",
  keys: true,
  vi: true,
  mouse: true,
  style: { border: { fg: "cyan" }, item: { fg: "white" }, selected: { bg: "blue", fg: "white", bold: true } },
  items: [],
});

const outputBox = blessed.box({
  parent: screen,
  top: 9,
  left: 32,
  width: "100%-32",
  height: "100%-13",
  label: " Details ",
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
});

let currentMenu = "main";
let currentLog = "bridge";
let statusTimer;
let currentStatusMessage = "Ready";
let modalDepth = 0;

menu.focus();

screen.key(["q", "C-c"], () => {
  if (modalDepth > 0) return;
  shutdown();
});
menu.key(["enter"], async () => {
  if (modalDepth > 0) return;
  await runSelectedAction();
});
screen.key(["1"], async () => {
  if (modalDepth > 0) return;
  await openMenu("setup", "Setup menu");
});
screen.key(["2"], async () => {
  if (modalDepth > 0) return;
  await openMenu("bridge", "Bridge menu");
});
screen.key(["3"], async () => {
  if (modalDepth > 0) return;
  await openMenu("logs", "Logs menu");
});
screen.key(["r"], async () => {
  if (modalDepth > 0) return;
  setMessage("Refreshed");
  await refreshAll();
});
menu.key(["escape", "backspace", "left", "h"], () => {
  if (modalDepth > 0) return;
  goBack();
});
screen.key(["pageup"], () => { outputBox.scroll(-15); screen.render(); });
screen.key(["pagedown"], () => { outputBox.scroll(15); screen.render(); });

setMenu("main");
await refreshAll();
statusTimer = setInterval(refreshAll, 2500);

const envStatus = await getEnvStatus();
if (!envStatus.configured) {
  currentMenu = "setup";
  setMenu("setup");
  setMessage("Config incomplete. Open the first-run wizard with Enter.", true);
  outputBox.setLabel(" Details ");
  outputBox.setContent([
    `Config file: ${ENV_FILE}`,
    "",
    "Detected issues:",
    ...envStatus.issues.map((issue) => `- ${issue}`),
    "",
    "Tip: use Setup -> First-run config wizard.",
  ].join("\n"));
  screen.render();
}

async function runSelectedAction() {
  const item = menu.getItem(menu.selected)?.content;
  if (!item) return;
  await runAction(currentMenu, item);
}

async function runAction(section, item) {
  try {
    if (section === "main") {
      if (item === "Setup") {
        await openMenu("setup", "Setup menu");
      } else if (item === "Bridge") {
        await openMenu("bridge", "Bridge menu");
      } else if (item === "Logs") {
        await openMenu("logs", "Logs menu");
      } else if (item === "Refresh") {
        setMessage("Refreshed");
        await refreshAll();
      } else if (item === "Quit") {
        shutdown();
      }
      return;
    }

    if (item === "Back") {
      goBack();
      return;
    }

    if (section === "setup") {
      if (item === "First-run config wizard") {
        await runWizard();
      } else if (item === "Edit settings") {
        await runSettingsEditor();
      } else if (item === "Regenerate unlock secret") {
        await regenerateSecret();
      } else if (item === "Export TOTP QR") {
        await exportTotpQr();
      } else if (item === "Generate local systemd service") {
        await generateLocalService();
      } else if (item === "Test configuration") {
        await runConfigurationTest();
      }
    } else if (section === "bridge") {
      if (item === "Status") {
        setMessage("Bridge status refreshed");
        outputBox.setLabel(" Details ");
        outputBox.setContent(await renderBridgeSummary());
      } else if (item === "Start Telegram bridge process") {
        setMessage((await startBridge()).message);
        outputBox.setLabel(" Details ");
        outputBox.setContent(await renderBridgeSummary());
      } else if (item === "Stop Telegram bridge process") {
        setMessage((await stopBridge()).message);
        outputBox.setLabel(" Details ");
        outputBox.setContent(await renderBridgeSummary());
      } else if (item === "Restart Telegram bridge process") {
        setMessage((await restartBridge()).message);
        outputBox.setLabel(" Details ");
        outputBox.setContent(await renderBridgeSummary());
      } else if (item === "Temporarily unlock from local TUI") {
        await runLocalUnlock();
      } else if (item === "Show Telegram command reference") {
        setMessage("Showing Telegram command reference");
        outputBox.setLabel(" Telegram Commands ");
        outputBox.setContent(renderTelegramCommandReference());
      }
    } else if (section === "logs") {
      if (item === "Show bridge log") {
        currentLog = "bridge";
        setMessage(`Showing ${OUT_LOG}`);
      } else if (item === "Show audit log") {
        currentLog = "audit";
        setMessage(`Showing ${AUDIT_LOG}`);
      } else if (item === "Clear bridge log") {
        setMessage(await clearLogFile(OUT_LOG));
        currentLog = "bridge";
      } else if (item === "Clear audit log") {
        setMessage(await clearLogFile(AUDIT_LOG));
        currentLog = "audit";
      }
    }

    await refreshAll();
  } catch (error) {
    setMessage(`Error: ${error.message || String(error)}`, true);
    screen.render();
  }
}

async function openMenu(name, message) {
  currentMenu = name;
  setMenu(name);
  if (message) setMessage(message);
  await refreshAll();
}

function setMenu(name) {
  const config = MENUS[name] || MENUS.main;
  menu.setLabel(config.title);
  menu.clearItems();
  menu.setItems([...config.items]);
  menu.select(0);
  menu.focus();
  renderHelp();
  screen.render();
}

function goBack() {
  if (currentMenu === "main") {
    setMessage("At main menu. Press q to quit.");
    screen.render();
    return;
  }

  currentMenu = "main";
  setMenu("main");
  setMessage("Main menu");
  refreshAll().catch((error) => {
    setMessage(`Error: ${error.message || String(error)}`, true);
    screen.render();
  });
}

async function refreshAll() {
  const status = await getStatus();
  renderStatus(status);
  await renderDetails(status);
  renderHelp();
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

async function renderDetails(status) {
  if (currentMenu === "logs") {
    const target = currentLog === "bridge" ? OUT_LOG : AUDIT_LOG;
    const content = await readLogTail(target, 32000);
    outputBox.setLabel(` Logs - ${currentLog === "bridge" ? "bridge.out" : "audit.log"} `);
    outputBox.setContent(content || "(empty)");
    outputBox.setScrollPerc(100);
    return;
  }

  outputBox.setLabel(" Details ");
  if (currentMenu === "setup") {
    const env = status.env;
    outputBox.setContent([
      "Setup tools:",
      "- First-run config wizard",
      "- Edit settings",
      "- Regenerate unlock secret",
      "- Export TOTP QR",
      "- Generate local systemd service",
      "- Test configuration",
      "",
      `Config file: ${ENV_FILE}`,
      `Configured: ${env.configured ? "yes" : "no"}`,
      ...(env.issues.length ? ["", "Issues:", ...env.issues.map((issue) => `- ${issue}`)] : ["", "No config issues detected."]),
      "",
      "Clipboard note:",
      "For large paste/copy operations, it is usually easier to edit files outside the TUI.",
    ].join("\n"));
    return;
  }

  if (currentMenu === "bridge") {
    outputBox.setContent(await renderBridgeSummary());
    return;
  }

  outputBox.setContent([
    "Telegram Pi Bridge Manager",
    "",
    "This screen is a compact control panel for:",
    "- configuring the bridge",
    "- starting/stopping the bridge",
    "- viewing logs",
    "",
    "Navigation:",
    "- Enter opens the selected item",
    "- Esc goes back to the previous level",
    "- q quits the TUI",
    "- 1 / 2 / 3 jump to Setup / Bridge / Logs",
    "",
    "Tip: the menu on the left is the primary navigation.",
  ].join("\n"));
}

async function renderBridgeSummary() {
  const status = await getStatus();
  const checks = await testConfiguration();
  const warnings = checks.filter((check) => !check.ok);
  return [
    "Bridge controls:",
    "- Status",
    "- Start Telegram bridge process",
    "- Stop Telegram bridge process",
    "- Restart Telegram bridge process",
    "- Temporarily unlock from local TUI",
    "- Show Telegram command reference",
    "",
    `Running: ${status.running ? "yes" : "no"}`,
    `PID: ${status.pid ?? "-"}`,
    `Bridge log: ${status.outLog.path}`,
    `Audit log: ${status.auditLog.path}`,
    "",
    warnings.length
      ? `Warnings: ${warnings.length}`
      : "Configuration checks look good.",
    ...warnings.slice(0, 5).map((warning) => `- ${warning.name}: ${warning.details}`),
    "",
    "Telegram commands available to the bot:",
    "- /help, /status, /unlock, /lock, /clear",
    "- /new, /session, /compact, /name, /resume",
    "",
    "Local TUI-only action:",
    "- Temporarily unlock from local TUI",
    "",
    "Note: restarting here restarts the Telegram bridge process, not this TUI.",
  ].join("\n");
}

function renderTelegramCommandReference() {
  return [
    "Telegram command reference",
    "",
    "Core:",
    "- /help — show available commands",
    "- /status — show lock state",
    "- /unlock <code> — unlock temporarily",
    "- /lock — lock immediately",
    "- /clear — wipe this chat's saved session history",
    "",
    "Session management:",
    "- /new — start a fresh session for this chat",
    "- /session — show current session details",
    "- /compact [instructions] — compact long session context",
    "- /name <label> — name the current session",
    "- /resume — list saved sessions for this chat",
    "- /resume <n> — reopen one of those sessions",
    "",
    "Local TUI-only action:",
    "- Temporarily unlock from local TUI — signals the running bridge process to unlock locally",
    "",
    "Notes:",
    "- normal text prompts go to pi only while unlocked",
    "- these commands are used from Telegram, not from inside this TUI",
    "- this TUI manages the local bridge process and configuration",
  ].join("\n");
}

async function runLocalUnlock() {
  const config = await getEffectiveConfig();
  const ttlMinutes = normalizePositiveInt(config.UNLOCK_TTL_MINUTES || "15", 15);

  const confirmed = await askYesNo([
    "Temporarily unlock bridge from local TUI?",
    "",
    "This bypasses Telegram /unlock code entry.",
    "That is usually acceptable if local shell/TUI access is already trusted.",
    "If an untrusted person can launch this TUI, your problem is already larger than TOTP.",
    "",
    `Configured unlock TTL: ${ttlMinutes} minutes`,
    "This uses a local-only signal to the running bridge process.",
    "No restart needed.",
  ].join("\n"), true);
  if (!confirmed) return cancel();

  const result = await triggerLocalUnlock();
  setMessage(`Unlocked locally until ${new Date(result.unlockedUntil).toISOString()}`);
  outputBox.setLabel(" Details ");
  outputBox.setContent([
    "Local TUI unlock applied.",
    "",
    `Bridge PID: ${result.pid}`,
    `TTL: ${result.ttlMinutes} minutes`,
    `Unlocked until: ${new Date(result.unlockedUntil).toISOString()}`,
    "",
    "This action is local-only and is not available from Telegram.",
    "No bridge restart was performed.",
  ].join("\n"));
}

function renderHelp() {
  const section = currentMenu === "main" ? "Main" : `Main / ${currentMenu[0].toUpperCase() + currentMenu.slice(1)}`;
  const backHint = currentMenu === "main" ? "Esc hint" : "Esc back";
  const lines = [
    `{green-fg}${escapeTags(currentStatusMessage || "Ready")}{/green-fg}`,
    `{bold}${section}:{/bold} Enter select  {bold}${backHint}{/bold}  {bold}q{/bold} quit  {bold}r{/bold} refresh  {bold}PgUp/PgDn{/bold} scroll`,
    `{bold}1{/bold} Setup  {bold}2{/bold} Bridge  {bold}3{/bold} Logs`,
  ];
  helpBox.setContent(lines.join("\n"));
}

function setMessage(message, isError = false) {
  currentStatusMessage = `${isError ? "ERROR: " : ""}${message}`;
  helpBox.setContent("");
  renderHelp();
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
  outputBox.setLabel(" Details ");
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
      "Telegram bot token",
      "Unlock TTL",
      "Unlock method",
      "TOTP secret",
      "Shared unlock secret",
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
    ], "Telegram bot token");
    if (!choice || choice === "Back") break;

    if (choice === "Telegram bot token") {
      const value = await askText("Telegram bot token", config.TELEGRAM_BOT_TOKEN, { secret: true });
      if (value != null) config.TELEGRAM_BOT_TOKEN = value;
    } else if (choice === "Unlock TTL") {
      const value = await askText("Unlock TTL in minutes", String(config.UNLOCK_TTL_MINUTES));
      if (value != null) config.UNLOCK_TTL_MINUTES = normalizePositiveInt(value, 15);
    } else if (choice === "Unlock method") {
      const value = await askChoice("Unlock method", ["totp", "secret"], config.UNLOCK_METHOD);
      if (value) config.UNLOCK_METHOD = value;
    } else if (choice === "TOTP secret") {
      const value = await askText("TOTP secret (base32)", config.UNLOCK_TOTP_SECRET || generateTotpSecret(), { secret: true });
      if (value != null) {
        config.UNLOCK_METHOD = "totp";
        config.UNLOCK_TOTP_SECRET = value;
      }
    } else if (choice === "Shared unlock secret") {
      const value = await askText("Shared unlock secret", config.UNLOCK_SHARED_SECRET || generateSharedSecret(), { secret: true });
      if (value != null) {
        config.UNLOCK_METHOD = "secret";
        config.UNLOCK_SHARED_SECRET = value;
      }
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
    outputBox.setLabel(" Details ");
    outputBox.setContent(`New TOTP secret:\n\n${config.UNLOCK_TOTP_SECRET}\n\nUse Export TOTP QR to create a QR image.`);
  } else {
    config.UNLOCK_METHOD = "secret";
    config.UNLOCK_SHARED_SECRET = generateSharedSecret();
    await writeEnvConfig(config);
    setMessage("Generated new shared secret and saved .env");
    outputBox.setLabel(" Details ");
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
  outputBox.setLabel(" Details ");
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
  outputBox.setLabel(" Details ");
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
  outputBox.setLabel(" Details ");
  outputBox.setContent(lines.join("\n"));
}

async function askText(label, initial = "", options = {}) {
  modalDepth += 1;
  return new Promise((resolve) => {
    const box = blessed.box({
      parent: screen,
      border: "line",
      height: 11,
      width: "82%",
      top: "center",
      left: "center",
      label: ` ${label} `,
      tags: true,
      keys: true,
      vi: true,
      style: { border: { fg: "green" }, fg: "white", bg: "black" },
    });

    let hidden = false;
    const hint = blessed.text({
      parent: box,
      top: 0,
      left: 1,
      right: 1,
      height: 2,
      tags: true,
      content: "",
    });

    const input = blessed.textbox({
      parent: box,
      name: "value",
      inputOnFocus: true,
      mouse: true,
      keys: true,
      vi: true,
      top: 3,
      left: 1,
      right: 1,
      height: 3,
      border: "line",
      style: { border: { fg: "cyan" }, fg: "white", bg: "black" },
      censor: false,
      secret: false,
      value: String(initial ?? ""),
    });

    const updateHint = () => {
      hint.setContent(
        options.secret
          ? `Paste/type value. Enter = save, Esc = cancel, F2 = ${hidden ? "show" : "hide"}. Currently ${hidden ? "hidden" : "visible"}.`
          : "Paste/type value. Enter = save, Esc = cancel."
      );
    };

    const cleanup = (value) => {
      modalDepth = Math.max(0, modalDepth - 1);
      box.destroy();
      menu.focus();
      screen.render();
      resolve(value);
    };

    input.on("submit", (value) => cleanup(typeof value === "string" ? value.trim() : ""));
    input.key(["escape"], () => cleanup(null));
    box.key(["escape"], () => cleanup(null));
    if (options.secret) {
      input.key(["f2"], () => {
        hidden = !hidden;
        input.censor = hidden;
        updateHint();
        screen.render();
      });
    }

    updateHint();
    input.focus();
    input.readInput();
    screen.render();
  });
}

async function askChoice(label, options, current) {
  modalDepth += 1;
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
    const finish = (value) => {
      modalDepth = Math.max(0, modalDepth - 1);
      list.destroy();
      menu.focus();
      screen.render();
      resolve(value);
    };
    list.key(["enter"], () => finish(list.getItem(list.selected).content));
    list.key(["escape", "q", "left", "h", "backspace"], () => finish(null));
  });
}

async function askYesNo(message, defaultYes = true) {
  modalDepth += 1;
  return new Promise((resolve) => {
    const box = blessed.box({
      parent: screen,
      border: "line",
      width: "80%",
      height: 14,
      top: "center",
      left: "center",
      label: " Confirm ",
      tags: true,
      keys: true,
      vi: true,
      scrollable: true,
      alwaysScroll: true,
      style: { border: { fg: "green" } },
      content: `${escapeTags(message)}\n\n${defaultYes ? "Enter/Y = yes, N = no, Esc = cancel" : "Enter/N = no, Y = yes, Esc = cancel"}`,
    });

    const finish = (value) => {
      modalDepth = Math.max(0, modalDepth - 1);
      box.destroy();
      menu.focus();
      screen.render();
      resolve(value);
    };

    box.key(["enter", "y", "Y"], () => finish(true));
    box.key(["n", "N"], () => finish(false));
    box.key(["escape", "q", "left", "h", "backspace"], () => finish(null));
    box.focus();
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
