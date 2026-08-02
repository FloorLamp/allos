import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Every `router.refresh()` in the app is classified (issue #1878).
//
// The dirty-form registry only works if "chrome-initiated" stays an explicit
// opt-in at the CALL SITE. The moment it becomes a heuristic — or the moment a
// new background actor calls `router.refresh()` directly because nobody told it
// not to — the fix is back to whack-a-mole, and the failure is the silent kind:
// a half-typed record form emptied by a repaint nobody asked for.
//
// So this scan requires every refresh call site to be in exactly one bucket:
//
//   CHROME  — a background actor repainting on its own initiative. It must route
//             through `useChromeRefresh` and must NOT call `router.refresh()`.
//   USER    — a repaint the person in front of the screen asked for, by a gesture
//             or by their own submit. It calls `router.refresh()` directly and
//             must NEVER defer: swallowing a pull-to-refresh because some form is
//             dirty would be its own bug, and a worse one.
//
// A new call site fails this test until someone decides which it is. That
// decision is the whole point; the list below is the record of it.
//
// (`docs/internals/server-action-refresh.md` governs the different question of
// whether a refresh should exist at all. This one governs when it may land.)

const ROOT = path.join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "components"];

/**
 * Background actors. Each repaints because something happened elsewhere — not
 * because the user did anything — so each must ask the registry.
 */
const CHROME_CALL_SITES = [
  // Post-sync repaint after the offline queue replays through /api/offline-replay.
  "components/OfflineQueueProvider.tsx",
  // Poll noticed a paste/CSV import job finish.
  "components/ImportJobsToaster.tsx",
  // Poll noticed a medical-document extraction finish.
  "components/ExtractionToaster.tsx",
];

/**
 * User-initiated repaints, with the reason each one is the user's. These keep
 * calling `router.refresh()` directly and are deliberately NOT registry-gated.
 */
const USER_CALL_SITES: Record<string, string> = {
  "components/PullToRefresh.tsx":
    "the overscroll gesture IS the request for current data",
  "components/ReprocessDiffPanel.tsx":
    "follows the user's own 'Save changes' commit; deferring it would leave them staring at the rows they just replaced",
  "components/ImportDetailActions.tsx":
    "follows the user's own confirmed re-import",
  "app/(app)/settings/server/SmtpSettings.tsx":
    "follows the user's own 'Send test email', which persists the form without revalidating",
  "app/(app)/integrations/fitbit-takeout/TakeoutUpload.tsx":
    "follows the user's own upload",
  // The registry itself: the drain it owes, and the no-provider fallback.
  "components/DirtyFormRegistry.tsx":
    "the registry IS the chokepoint — this is the deferred repaint finally landing",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = SCANNED_DIRS.flatMap((d) => walk(path.join(ROOT, d))).map(
  (f) => ({
    rel: path.relative(ROOT, f).split(path.sep).join("/"),
    source: fs.readFileSync(f, "utf8"),
  })
);

/**
 * Call sites only. The string appears in plenty of prose — the doctrine comments
 * on the surviving sites, the JSX note in the app shell — and prose must not
 * register as a call, or the scan would just be a grep for a word.
 */
function callsRefresh(source: string): boolean {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return /\brouter\.refresh\(\)/.test(code);
}

describe("router.refresh() call sites are classified chrome or user (#1878)", () => {
  it("has no unclassified call site", () => {
    const found = files.filter((f) => callsRefresh(f.source)).map((f) => f.rel);
    const classified = new Set(Object.keys(USER_CALL_SITES));
    const unknown = found.filter((f) => !classified.has(f));
    expect(
      unknown,
      "A new router.refresh(): decide whether it is CHROME (route it through useChromeRefresh) or USER (add it to USER_CALL_SITES with the reason)."
    ).toEqual([]);
  });

  it("keeps every user-initiated refresh direct and undeferred", () => {
    for (const rel of Object.keys(USER_CALL_SITES)) {
      const file = files.find((f) => f.rel === rel);
      if (!file) throw new Error(`${rel} not found`);
      expect(callsRefresh(file!.source), `${rel} no longer refreshes`).toBe(
        true
      );
    }
  });

  it("routes every chrome refresh through the registry instead", () => {
    for (const rel of CHROME_CALL_SITES) {
      const file = files.find((f) => f.rel === rel);
      if (!file) throw new Error(`${rel} not found`);
      expect(
        file!.source.includes("useChromeRefresh"),
        `${rel} is a background actor and must repaint through useChromeRefresh`
      ).toBe(true);
      expect(
        callsRefresh(file!.source),
        `${rel} must not call router.refresh() directly — that bypasses the dirty-form registry`
      ).toBe(false);
    }
  });

  it("does not let a file be both", () => {
    for (const rel of CHROME_CALL_SITES) {
      expect(Object.keys(USER_CALL_SITES)).not.toContain(rel);
    }
  });
});
