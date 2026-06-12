export const TELEGRAM_MAX_MESSAGE = 4000;

export function splitForTelegram(text, maxLength = TELEGRAM_MAX_MESSAGE) {
  if (text.length <= maxLength) return [text];
  const minSplit = Math.floor(maxLength / 4);
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < minSplit) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < minSplit) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function safePreview(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
}

export function commandArgs(text) {
  const raw = String(text || "").trim();
  const firstSpace = raw.indexOf(" ");
  return firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
}

export function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
