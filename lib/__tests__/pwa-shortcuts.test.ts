import { describe, expect, it } from "vitest";
import {
  PWA_SHORTCUTS,
  QUICK_PARAM,
  SEARCH_SHORTCUT_ID,
  shortcutAction,
} from "@/lib/pwa-shortcuts";
import { LOG_ACTIVITY_ID, QUICK_LOG_ITEMS } from "@/lib/quick-log";

// The PWA shortcut registry is a pure list and its `?quick=` resolver is a pure
// function (issue #1424) — both pinned here, since the manifest itself is only
// observable through an installed app's long-press menu.

describe("PWA_SHORTCUTS registry", () => {
  it("exposes exactly the three OS-menu entries, in order", () => {
    expect(PWA_SHORTCUTS.map((s) => s.id)).toEqual([
      LOG_ACTIVITY_ID,
      "log-dose",
      SEARCH_SHORTCUT_ID,
    ]);
  });

  it("every url is /?<QUICK_PARAM>=<id> — the literal can't drift from the id", () => {
    // The urls are written as literals so typedRoutes can validate them (#285);
    // this is the guard that keeps the literal and the identity in agreement.
    for (const s of PWA_SHORTCUTS) {
      expect(s.url).toBe(`/?${QUICK_PARAM}=${s.id}`);
    }
  });

  it("quick-log shortcut copy is the sheet's copy, not a second string", () => {
    // The whole reason lib/pwa-shortcuts derives from QUICK_LOG_ITEMS: renaming
    // the sheet row renames the home-screen shortcut. A restated literal here
    // would let the two drift.
    for (const s of PWA_SHORTCUTS) {
      const item = QUICK_LOG_ITEMS.find((i) => i.id === s.id);
      if (!item) continue;
      expect(s.name).toBe(item.label);
      expect(s.description).toBe(item.hint);
    }
  });

  it("names and descriptions are non-empty (an OS menu row with no label is unusable)", () => {
    for (const s of PWA_SHORTCUTS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("every url stays inside the manifest scope (/)", () => {
    for (const s of PWA_SHORTCUTS) {
      expect(s.url.startsWith("/")).toBe(true);
      expect(s.url.startsWith("//")).toBe(false);
    }
  });
});

describe("shortcutAction", () => {
  it("resolves search to the palette", () => {
    expect(shortcutAction(SEARCH_SHORTCUT_ID)).toEqual({ kind: "search" });
  });

  it("resolves every quick-log id — the manifest is a subset, the resolver is the registry", () => {
    for (const item of QUICK_LOG_ITEMS) {
      expect(shortcutAction(item.id)).toEqual({ kind: "quick-log", item });
    }
  });

  it("returns null for an unknown value instead of falling back to Log activity", () => {
    // quickLogItem() falls back — correct for the sheet, wrong for a URL. A
    // stale bookmark or a truncated share must never pop an editor the user did
    // not ask for.
    expect(shortcutAction("lol")).toBeNull();
    expect(shortcutAction("")).toBeNull();
    expect(shortcutAction(null)).toBeNull();
    expect(shortcutAction(undefined)).toBeNull();
  });

  it("drops training-only entries for an age-restricted profile", () => {
    // Same gate quickLogMenu applies: a restricted profile has no training
    // surface at all.
    expect(shortcutAction(LOG_ACTIVITY_ID, true)).toBeNull();
    // Non-training entries are unaffected.
    expect(shortcutAction("log-dose", true)).not.toBeNull();
    expect(shortcutAction(SEARCH_SHORTCUT_ID, true)).toEqual({
      kind: "search",
    });
  });

  it("only ever yields targets the shell can already open", () => {
    // The handler dispatches the QuickLogTarget union exactly as QuickLogSheet
    // does. No shortcut resolves to a `navigate` row today; if one ever does,
    // this fails and the handler's navigate branch gets a real test.
    for (const s of PWA_SHORTCUTS) {
      const action = shortcutAction(s.id);
      expect(action).not.toBeNull();
      if (action!.kind === "quick-log") {
        expect(["activity", "overlay"]).toContain(action!.item.target.kind);
      }
    }
  });
});
