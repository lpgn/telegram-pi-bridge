import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * JSON-lines audit logger with size-based rotation. Writes are serialized
 * through an internal queue so rotation cannot race concurrent appends.
 * A write failure is logged to stderr but never throws into handlers.
 */
export function createAuditLogger(filePath, { maxBytes = 5_000_000, keep = 3 } = {}) {
  let queue = Promise.resolve();

  async function rotateIfNeeded() {
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size < maxBytes) return;
    await rm(`${filePath}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i -= 1) {
      await rename(`${filePath}.${i}`, `${filePath}.${i + 1}`).catch(() => {});
    }
    await rename(filePath, `${filePath}.1`).catch(() => {});
  }

  return function append(entry) {
    queue = queue
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await rotateIfNeeded();
        await appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        console.error("Audit log write failed:", error);
      });
    return queue;
  };
}

/** Tighten permissions of an existing audit log created under an older umask. */
export async function tightenLogPermissions(filePath) {
  await chmod(filePath, 0o600).catch(() => {});
}
