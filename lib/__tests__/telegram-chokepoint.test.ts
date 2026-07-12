import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the Telegram channel chokepoint (issue #454). Every
// outbound Telegram obligation — length/keyboard limits, the "[Name] " attribution
// prefix, HTML escaping, delivery accounting — is owned by ONE module, and the
// three raw message-mutating primitives that reach the wire live in
// lib/notifications/telegram-api.ts. This test reads the repo's own source as TEXT
// (no DB, no network, so it stays "pure" in the vitest sense) and fails the build
// if any module OTHER than the chokepoint imports those guarded primitives, or if
// the raw Bot API send/edit methods are called anywhere but the transport module —
// i.e. a new sender or callback handler tries to reach the channel directly and so
// would re-implement (or forget) a cross-cutting obligation, the exact class of bug
// (#377/#378/#379) that motivated the consolidation.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The message-mutating primitives that own the send/edit obligations. Only the
// chokepoint may import these; every other outbound path goes through the
// chokepoint's higher-level ops (telegramChannel / sendTelegramMessage /
// rebuildMessage / closeMessage / updateMessageKeyboard).
const GUARDED_IMPORTS = [
  "sendMessageRaw",
  "editMessageTextRaw",
  "editMessageReplyMarkupRaw",
];

// The raw Bot API method strings those primitives POST. They must appear only in
// the transport module — a `call("sendMessage", …)` anywhere else is a bypass.
const GUARDED_CALLS = [
  "sendMessage",
  "editMessageText",
  "editMessageReplyMarkup",
];

const CHOKEPOINT = "lib/notifications/telegram.ts";
const TRANSPORT = "lib/notifications/telegram-api.ts";

// Directories to scan for PRODUCTION source. Tests legitimately mock/inspect the
// raw primitives (the callback DB test stubs telegram-api's network hop), so the
// test tiers are excluded — the guard is about senders shipping to users.
const SCAN_DIRS = ["lib", "app", "scripts"];

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full);
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("Telegram channel chokepoint boundary (issue #454)", () => {
  it("the guarded send/edit primitives are imported only by the chokepoint", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === CHOKEPOINT) continue; // the chokepoint is the sole importer
      // Only flag an import that actually pulls a guarded name FROM the transport
      // module — an unrelated local identifier of the same name wouldn't be a
      // channel bypass.
      const importsTransport =
        /from\s+["'][^"']*telegram-api["']/.test(text) ||
        text.includes('"./telegram-api"') ||
        text.includes("'./telegram-api'");
      if (!importsTransport) continue;
      for (const name of GUARDED_IMPORTS) {
        if (new RegExp(`\\b${name}\\b`).test(text)) {
          offenders.push(`${rel} imports ${name}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the raw Bot API send/edit methods are POSTed only from the transport module", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (rel === TRANSPORT) continue; // the transport module owns the raw call()
      for (const method of GUARDED_CALLS) {
        if (
          text.includes(`call("${method}"`) ||
          text.includes(`call('${method}'`)
        ) {
          offenders.push(`${rel} calls ${method}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the chokepoint module and the transport module both exist", () => {
    expect(fs.existsSync(path.join(REPO, CHOKEPOINT))).toBe(true);
    expect(fs.existsSync(path.join(REPO, TRANSPORT))).toBe(true);
  });
});
