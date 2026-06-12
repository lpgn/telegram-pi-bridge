import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = resolveAppDir();
export const DATA_DIR = path.join(APP_DIR, "data");
export const LOGS_DIR = path.join(APP_DIR, "logs");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

export function expandHome(input) {
  if (!input.startsWith("~")) return input;
  return path.join(os.homedir(), input.slice(1));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAppDir() {
  const override = process.env.TELEPI_HOME?.trim() || process.env.TELEPI_APP_DIR?.trim();
  if (override) return path.resolve(expandHome(override));

  const cwd = process.cwd();
  if (looksLikeTelepiDir(cwd)) return cwd;

  return PACKAGE_DIR;
}

// Only adopt the cwd as the app dir when its env file is actually a telepi
// config; matching on package.json alone would hijack any Node project.
function looksLikeTelepiDir(dir) {
  for (const name of [".env", ".env.example"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file, "utf8").includes("TELEGRAM_BOT_TOKEN")) return true;
    } catch {
      // Unreadable env file; keep looking.
    }
  }
  return false;
}
