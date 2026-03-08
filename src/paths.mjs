import { existsSync } from "node:fs";
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
  if (
    existsSync(path.join(cwd, ".env")) ||
    existsSync(path.join(cwd, ".env.example")) ||
    existsSync(path.join(cwd, "package.json"))
  ) {
    return cwd;
  }

  return PACKAGE_DIR;
}
