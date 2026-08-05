import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_NOTIFICATION_KINDS,
  NOTIFICATION_KIND_REGISTRY,
  NON_CONFIGURABLE_KINDS,
  TOGGLEABLE_NOTIFICATION_KINDS,
  SAFETY_NOTIFICATION_KINDS,
  isSafetyKind,
  notificationKindEntry,
} from "../notifications/kinds";
import type { NotificationKind } from "../notifications/types";

// The kind-registry reflection test (#1462 §6). The Notifications settings page used
// to enable each kind TWICE — a mega-card of per-kind toggles plus a separate
// kind × channel matrix — so the two lists could (and did) disagree about which
// kinds exist. The registry is now the one list; these tests pin that it can't drift
// from the delivery layer in either direction:
//
//   - a kind DISPATCHED by lib/notifications with no place in the registry (or an
//     explicit, reasoned non-configurable entry) would be un-routable in the UI;
//   - a registry row for a kind the type union doesn't have would render a control
//     that gates nothing.

const NOTIFICATIONS_DIR = join(process.cwd(), "lib", "notifications");

describe("kind registry ⇄ the NotificationKind union", () => {
  it("the runtime kind list is the union, with no duplicates", () => {
    expect(new Set(ALL_NOTIFICATION_KINDS).size).toBe(
      ALL_NOTIFICATION_KINDS.length
    );
    // The `satisfies readonly NotificationKind[]` on ALL_NOTIFICATION_KINDS makes an
    // INVALID member a compile error; this pins the other direction at runtime — a
    // union member nobody listed shows up as an unaccounted kind below.
    expect(ALL_NOTIFICATION_KINDS.length).toBeGreaterThan(10);
  });

  it("every kind is either a registry row or an explicitly-reasoned exclusion", () => {
    const configured = new Set(NOTIFICATION_KIND_REGISTRY.map((e) => e.kind));
    const unaccounted = ALL_NOTIFICATION_KINDS.filter(
      (k) => !configured.has(k) && !NON_CONFIGURABLE_KINDS[k]
    );
    expect(
      unaccounted,
      `kinds with neither a settings row nor a NON_CONFIGURABLE_KINDS reason: ${unaccounted.join(", ")}`
    ).toEqual([]);
  });

  it("no kind is both configurable and excluded", () => {
    const both = NOTIFICATION_KIND_REGISTRY.filter(
      (e) => NON_CONFIGURABLE_KINDS[e.kind]
    ).map((e) => e.kind);
    expect(both).toEqual([]);
  });

  it("every exclusion names a real kind and gives a reason", () => {
    for (const [kind, reason] of Object.entries(NON_CONFIGURABLE_KINDS)) {
      expect(ALL_NOTIFICATION_KINDS).toContain(kind as NotificationKind);
      expect((reason ?? "").length, `reason for ${kind}`).toBeGreaterThan(20);
    }
  });
});

describe("registry rows are well-formed", () => {
  it("kinds are unique", () => {
    const kinds = NOTIFICATION_KIND_REGISTRY.map((e) => e.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("every row has a label and a one-sentence blurb", () => {
    for (const e of NOTIFICATION_KIND_REGISTRY) {
      expect(e.label.length).toBeGreaterThan(2);
      // The copy standard (#945): helper text under a control is ONE sentence;
      // anything longer belongs in `more`, behind the row's disclosure.
      const sentences = e.blurb.match(/[.?!]/g)?.length ?? 0;
      expect(sentences, `blurb for ${e.kind}: ${e.blurb}`).toBe(1);
    }
  });

  it("every control names the form fields it writes", () => {
    for (const e of NOTIFICATION_KIND_REGISTRY) {
      switch (e.control.type) {
        case "always":
          break;
        case "toggle":
        case "time":
          expect(e.control.field, `${e.kind} control field`).toBeTruthy();
          break;
        case "day-time":
          expect(e.control.dayField).toBeTruthy();
          expect(e.control.timeField).toBeTruthy();
          break;
      }
    }
  });

  it("form field names are unique across rows (no two kinds writing one setting)", () => {
    const fields: string[] = [];
    for (const e of NOTIFICATION_KIND_REGISTRY) {
      if (e.control.type === "toggle" || e.control.type === "time")
        fields.push(e.control.field);
      if (e.control.type === "day-time")
        fields.push(e.control.dayField, e.control.timeField);
      for (const x of e.extras ?? []) fields.push(x.field);
    }
    expect(new Set(fields).size, fields.join(", ")).toBe(fields.length);
  });

  it("notificationKindEntry finds rows and misses non-rows", () => {
    expect(notificationKindEntry("digest")?.label).toBe("Morning digest");
    expect(notificationKindEntry("test")).toBeUndefined();
  });
});

describe("safety classification is unchanged by the consolidation", () => {
  it("keeps exactly the historical safety set", () => {
    // #928's set: scheduled dose reminders, missed-dose escalation, the PRN redose
    // notice. The #1462 §6 rework is presentation-only, so this must not move.
    expect([...SAFETY_NOTIFICATION_KINDS].sort()).toEqual([
      "dose",
      "escalation",
      "redose",
    ]);
    expect(isSafetyKind("dose")).toBe(true);
    expect(isSafetyKind("refill")).toBe(false);
  });

  it("no safety kind has a per-kind enable (they are channel-routing only)", () => {
    for (const e of NOTIFICATION_KIND_REGISTRY) {
      if (!e.safety) continue;
      expect(
        e.control.type,
        `safety kind ${e.kind} must not gain a settings enable`
      ).toBe("always");
    }
  });
});

describe("the matrix rows derive from the registry", () => {
  it("TOGGLEABLE_NOTIFICATION_KINDS is the registry, in order", () => {
    expect(TOGGLEABLE_NOTIFICATION_KINDS.map((k) => k.kind)).toEqual(
      NOTIFICATION_KIND_REGISTRY.map((e) => e.kind)
    );
    expect(TOGGLEABLE_NOTIFICATION_KINDS.map((k) => k.label)).toEqual(
      NOTIFICATION_KIND_REGISTRY.map((e) => e.label)
    );
  });

  it("never offers the un-gateable kinds as rows", () => {
    const kinds = TOGGLEABLE_NOTIFICATION_KINDS.map((k) => k.kind);
    expect(kinds).not.toContain("test");
    expect(kinds).not.toContain("other");
  });
});

describe("dispatch ⇄ registry", () => {
  // Source-scan every `kind: "x"` literal the notification layer actually sends, so
  // a NEW kind can't ship into dispatch while the settings UI stays unaware of it.
  function dispatchedKinds(): string[] {
    const out = new Set<string>();
    for (const name of readdirSync(NOTIFICATIONS_DIR)) {
      if (!name.endsWith(".ts")) continue;
      // The registry and the type union declare kinds; they don't dispatch them.
      if (name === "kinds.ts" || name === "types.ts") continue;
      const src = readFileSync(join(NOTIFICATIONS_DIR, name), "utf8");
      for (const m of src.matchAll(/\bkind:\s*"([a-z-]+)"/g)) {
        // `kind` is a common discriminant in this directory (the Telegram callback
        // handlers' typed outcome unions use one too). Only count a literal that
        // sits inside something shaped like a NotificationMessage — an object with a
        // `title` and a `body` — which is what actually carries a delivered kind.
        const window = src.slice(Math.max(0, m.index - 600), m.index + 600);
        if (/\btitle:/.test(window) && /\bbody\b/.test(window)) out.add(m[1]);
      }
    }
    return [...out].sort();
  }

  it("finds dispatch sites (the scanner isn't silently empty)", () => {
    const found = dispatchedKinds();
    expect(found.length).toBeGreaterThan(4);
    expect(found).toContain("dose");
  });

  it("every dispatched kind is a real kind and is accounted for", () => {
    const known = new Set<string>(ALL_NOTIFICATION_KINDS);
    const configured = new Set(NOTIFICATION_KIND_REGISTRY.map((e) => e.kind));
    const unknown = dispatchedKinds().filter((k) => !known.has(k));
    expect(
      unknown,
      `dispatched kinds missing from the NotificationKind union: ${unknown.join(", ")}`
    ).toEqual([]);
    const unhandled = dispatchedKinds().filter(
      (k) =>
        !configured.has(k as NotificationKind) &&
        !NON_CONFIGURABLE_KINDS[k as NotificationKind]
    );
    expect(
      unhandled,
      `dispatched kinds with no settings row and no documented exclusion: ${unhandled.join(", ")}`
    ).toEqual([]);
  });
});
