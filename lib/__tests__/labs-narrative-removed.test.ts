import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

// Removal guard for the AI lab-trend interpretation (#20), deleted with the Trends →
// Biomarkers tab (#1164). The card overlapped the deterministic trajectory rules (#41),
// tended to generically restate the flags, and sat against the app's no-diagnosis
// stance — so it was dropped, not ported. This pins the #203 side-state cleanup so the
// generator can't quietly grow back: no `generateLabTrend*` symbol survives anywhere in
// the source tree, and the `lib/lab-trend-narrative.ts` module (its pure prompt/offline
// half) stays deleted. If a future feature legitimately reintroduces a lab-trend
// narrative, it does so under a new name with its own review — never by resurrecting
// these exact symbols.

const ROOT = path.resolve(__dirname, "..", "..");

// The forbidden identifiers — the action, the impure generator, and its gather.
const FORBIDDEN = [
  "generateLabTrend",
  "generateLabTrendInterpretation",
  "gatherLabTrendInput",
];

describe("lab-trend narrative removal (#1164/#203)", () => {
  it("no lab-trend generator symbol survives in app/ or lib/", () => {
    // ripgrep the tracked source (fast, respects .gitignore); tolerate a non-zero exit
    // (no matches) by capturing it. This file itself is excluded so its own mentions of
    // the forbidden names don't self-trip.
    const pattern = FORBIDDEN.join("|");
    let out = "";
    try {
      out = execSync(
        `git grep -n -E "${pattern}" -- 'app/**' 'lib/**' ':!lib/__tests__/labs-narrative-removed.test.ts'`,
        { cwd: ROOT, encoding: "utf8" }
      );
    } catch (e: unknown) {
      // git grep exits 1 when there are no matches — the passing case.
      const err = e as { status?: number; stdout?: string };
      if (err.status === 1) out = err.stdout ?? "";
      else throw e;
    }
    expect(out.trim()).toBe("");
  });

  it("the lab-trend-narrative module is deleted", () => {
    expect(existsSync(path.join(ROOT, "lib", "lab-trend-narrative.ts"))).toBe(
      false
    );
  });

  it("the NarrativeKind union no longer carries the labs kind", () => {
    const src = readFileSync(
      path.join(ROOT, "lib", "types", "coaching.ts"),
      "utf8"
    );
    const match = src.match(/export type NarrativeKind =([^;]+);/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain('"labs"');
  });
});
