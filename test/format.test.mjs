import test from "node:test";
import assert from "node:assert/strict";

import {
  TELEGRAM_MAX_MESSAGE,
  commandArgs,
  parseBoolean,
  safePreview,
  splitForTelegram,
} from "../src/telegram-format.mjs";
import { parseEnv } from "../src/manager-lib.mjs";

test("splitForTelegram passes short text through unchanged", () => {
  assert.deepEqual(splitForTelegram("hello"), ["hello"]);
});

test("splitForTelegram keeps every chunk within the limit", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} with some padding text`).join("\n");
  const chunks = splitForTelegram(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TELEGRAM_MAX_MESSAGE, `chunk of ${chunk.length} exceeds limit`);
    assert.ok(chunk.length > 0);
  }
});

test("splitForTelegram preserves content modulo trimmed whitespace", () => {
  const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const chunks = splitForTelegram(text, 1000);
  assert.equal(chunks.join(" "), text);
});

test("splitForTelegram handles text with no break points", () => {
  const text = "x".repeat(10_500);
  const chunks = splitForTelegram(text);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) assert.ok(chunk.length <= TELEGRAM_MAX_MESSAGE);
});

test("safePreview collapses whitespace and truncates at 200 chars", () => {
  assert.equal(safePreview("  a\n\tb   c "), "a b c");
  const long = "y".repeat(250);
  const preview = safePreview(long);
  assert.equal(preview.length, 201); // 200 chars + ellipsis
  assert.ok(preview.endsWith("…"));
});

test("commandArgs extracts everything after the command", () => {
  assert.equal(commandArgs("/unlock 123456"), "123456");
  assert.equal(commandArgs("/name  my session "), "my session");
  assert.equal(commandArgs("/lock"), "");
  assert.equal(commandArgs(""), "");
});

test("parseBoolean accepts common truthy spellings and falls back", () => {
  assert.equal(parseBoolean("true", false), true);
  assert.equal(parseBoolean("YES", false), true);
  assert.equal(parseBoolean("0", true), false);
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean("", false), false);
});

test("parseEnv parses key=value lines and skips comments", () => {
  const env = parseEnv(["# comment", "A=1", "  B = spaced ", "broken-line", "C=a=b"].join("\n"));
  assert.deepEqual(env, { A: "1", B: "spaced", C: "a=b" });
});
