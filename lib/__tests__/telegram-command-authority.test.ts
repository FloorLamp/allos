// PURE TIER — ONE authority for "which text triggers this handler" (issue #2004).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The dispatcher resolved a verb once, through `parseCommand`/the alias table, and
// routed on the result. Then `handleDoseCommand`, `handleSymptomCommand` and
// `handleTempCommand` each re-validated the RAW TEXT against a hand-written regex of
// their own (`/^\/dose(@\w+)?(\s|$)/i` and friends). Two independent answers to one
// question, kept in step by hand.
//
// The failure that buys is silence — the exact class #1895 was written to eliminate.
// Add an alias to TELEGRAM_COMMANDS without editing the matching private regex and
// the dispatcher routes, the availability gate says the verb exists, and the handler
// declines: zero replies, which from the chat's side is indistinguishable from an
// outage.
//
// ── WHAT IS PINNED ───────────────────────────────────────────────────────────
//
// Two halves, because either alone is escapable:
//
//   AGREEMENT — over the whole command table, every text that routes to a verb also
//   satisfies that verb's guard, and satisfies NO other verb's. Driven off
//   TELEGRAM_COMMANDS itself, so a new command or alias is covered the moment it is
//   declared rather than when someone remembers to add a case.
//
//   STRUCTURE — a source scan (the house pattern: profile-scoping, phi-scan, the
//   chokepoint guard and the reconcile registry all read the repo's own text) that
//   fails if any notification module reintroduces a slash-command regex literal. The
//   agreement half can only test the vocabulary that exists; the scan is what stops a
//   SECOND authority from being written at all.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TELEGRAM_COMMANDS,
  isCommandText,
  parseCommand,
} from "@/lib/notifications/telegram-commands";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NOTIFY_DIR = path.join(REPO, "lib/notifications");

// Every text that means "run this verb": its own name and each alias.
function triggersFor(name: string): string[] {
  const c = TELEGRAM_COMMANDS.find((x) => x.name === name);
  return c ? [c.name, ...(c.aliases ?? [])] : [];
}

// The shapes Telegram actually delivers for one verb. A group appends `@botname`; a
// user may type anything after the verb; case is theirs.
function messageFormsFor(verb: string): string[] {
  return [
    `/${verb}`,
    `/${verb}@allosbot`,
    `/${verb} 38.5`,
    `/${verb}@allosbot 38.5`,
    `  /${verb}  `,
    `/${verb.toUpperCase()}`,
  ];
}

describe("isCommandText agrees with the dispatcher, by construction", () => {
  it("every verb and alias the vocabulary declares satisfies its OWN guard", () => {
    for (const c of TELEGRAM_COMMANDS) {
      for (const verb of triggersFor(c.name)) {
        for (const text of messageFormsFor(verb)) {
          expect(isCommandText(c.name, text), `${c.name} ← ${text}`).toBe(true);
        }
      }
    }
  });

  it("the guard and the router resolve the SAME name for the same text", () => {
    // The whole point: one parse, one answer. A guard that agreed on the bare verb
    // but not on the `@botname` or args form would still strand a real message.
    for (const c of TELEGRAM_COMMANDS) {
      for (const verb of triggersFor(c.name)) {
        for (const text of messageFormsFor(verb)) {
          const routed = parseCommand(text)?.name ?? null;
          expect(routed, text).toBe(c.name);
          expect(isCommandText(routed ?? "", text), text).toBe(true);
        }
      }
    }
  });

  it("no verb's trigger satisfies another verb's guard", () => {
    // Exclusivity, over the real table: `/symptoms` must not answer as `/symptom`'s
    // neighbour, and a future `/dosed` must not be claimed by `/dose`.
    for (const c of TELEGRAM_COMMANDS) {
      for (const verb of triggersFor(c.name)) {
        for (const other of TELEGRAM_COMMANDS) {
          if (other.name === c.name) continue;
          expect(
            isCommandText(other.name, `/${verb}`),
            `/${verb} must not trigger ${other.name}`
          ).toBe(false);
        }
      }
    }
  });

  it("a near-miss is not a trigger", () => {
    // The old private regexes anchored on a prefix plus a separator; this asserts the
    // shared parser keeps that discipline. `/doses` is a different (unknown) verb, not
    // a `/dose`, and ordinary chat is not addressed to the bot at all.
    expect(isCommandText("dose", "/doses")).toBe(false);
    expect(isCommandText("dose", "/dosed")).toBe(false);
    expect(isCommandText("dose", "dose")).toBe(false);
    expect(isCommandText("dose", "take a /dose")).toBe(false);
    expect(isCommandText("temp", "/tempo")).toBe(false);
    expect(isCommandText("symptom", "/symptomatic")).toBe(false);
  });

  it("no text at all is not a trigger", () => {
    // A photo, a sticker, a poll: `message.text` is undefined and the handler must
    // decline rather than throw.
    for (const c of TELEGRAM_COMMANDS) {
      expect(isCommandText(c.name, undefined)).toBe(false);
      expect(isCommandText(c.name, null)).toBe(false);
      expect(isCommandText(c.name, "")).toBe(false);
    }
  });

  it("a name that is not in the vocabulary matches nothing", () => {
    // The guard cannot be used to invent a verb the `/` menu never offers.
    expect(isCommandText("nonsense", "/nonsense")).toBe(false);
  });
});

describe("no SECOND authority is written anywhere", () => {
  // A slash-command regex literal — `/^\/dose…`, `/^\/symptoms?…`. The generic parser
  // in telegram-commands.ts is the one legitimate occurrence, and it is excluded by
  // name rather than by shape so that the exemption is visible here.
  const SLASH_COMMAND_REGEX = /\/\^\\\/[A-Za-z]/;
  const PARSER = "telegram-commands.ts";

  it("no notification module tests message text against its own command regex", () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(NOTIFY_DIR)) {
      if (!file.endsWith(".ts") || file === PARSER) continue;
      const text = fs.readFileSync(path.join(NOTIFY_DIR, file), "utf8");
      // Strip comments: this test's own defect story is quoted in prose in several
      // of these headers, and a documented regex is not a second authority.
      const src = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[^\n]*?\/\/.*$/gm, "");
      if (SLASH_COMMAND_REGEX.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `these modules hard-code a slash-command regex instead of asking ` +
        `isCommandText(): ${offenders.join(", ")}. The vocabulary in ` +
        `${PARSER} is the only authority on which text triggers which verb — ` +
        `a private copy drifts, and a drifted copy answers with silence (#2004).`
    ).toEqual([]);
  });

  it("the scan can actually see the pattern it forbids", () => {
    // A guard whose regex never matches anything passes forever. This proves the
    // detector against the literal shape the three handlers used to carry.
    expect(
      SLASH_COMMAND_REGEX.test(
        String.raw`if (!/^\/dose(@\w+)?(\s|$)/i.test(t))`
      )
    ).toBe(true);
    // …and does not fire on the generic parser's own shape (a character class, not a
    // literal verb), which is why excluding one file is enough.
    expect(
      SLASH_COMMAND_REGEX.test(String.raw`/^\/([A-Za-z0-9_]+)(?:@\w+)?$/`)
    ).toBe(false);
  });
});
