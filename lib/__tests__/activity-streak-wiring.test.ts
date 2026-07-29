import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #1398 guard (#221: one question, one computation). lib/streak.ts exports THREE
// day-count functions, and only ONE of them — activityStreak — answers the question a
// surface labels "streak". The bug this pins: the Training week tile picked the strict
// currentStreak while the milestone engine and the weekly recap picked the rest-tolerant
// flexibleStreak, so the same profile was told "30-day activity streak" and "Streak 2"
// on one afternoon. Sharing the math (#222) was not enough — the VARIANT choice drifted.
//
// This is a pure source-scan (the profile-scoping / pace-chip-wiring precedent): it fails
// CI when a module picks a streak variant directly without being registered here, so a
// new streak surface has to state which question it is answering.

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every module that BUILDS a number a surface renders under the word "streak". Each
// must call activityStreak — never flexibleStreak/currentStreak — so all three agree.
const USER_FACING_STREAK_PRODUCERS = [
  "lib/queries/training/activities.ts", // Training + Journal week summary tile
  "lib/milestones-db.ts", // "N-day activity streak" milestone
  "lib/notifications/weekly-recap-data.ts", // weekly recap card + notification
];

// The modules allowed to name a streak VARIANT directly, with the reason each is not
// the user-facing "streak". Anything else that imports one fails the discovery check.
const VARIANT_CALLERS: Record<string, string> = {
  "lib/streak.ts": "the definitions themselves (activityStreak delegates here)",
  "lib/coaching/engine.ts":
    'the overtraining nudge\'s "trained N days in a row" — strict, over hard-session dates, its own label',
  "lib/notifications/weekly-recap-data.ts":
    'the recap\'s strictStreak, rendered as the separately-labelled "N-day consecutive" delta',
};

// Production source lives in these trees; tests and build output are excluded.
const SCAN_DIRS = ["lib", "app", "components"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".next" ||
        entry.name.startsWith("__")
      )
        continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function productionFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) out.push(...walk(path.join(ROOT, dir)));
  return out
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .filter((f) => !f.includes(".test."));
}

describe("activity streak wiring (#1398)", () => {
  it("every user-facing streak producer reads activityStreak", () => {
    for (const rel of USER_FACING_STREAK_PRODUCERS) {
      const src = read(rel);
      expect(src, `${rel} must build its streak from activityStreak`).toContain(
        "activityStreak("
      );
      // …and must not re-pick a variant for the same number.
      expect(src, `${rel} must not call flexibleStreak directly`).not.toContain(
        "flexibleStreak("
      );
    }
  });

  it("the Training week summary and the milestone engine cannot fork again", () => {
    // The two surfaces the issue caught disagreeing, pinned to the same symbol.
    const tile = read("lib/queries/training/activities.ts");
    const milestone = read("lib/milestones-db.ts");
    expect(tile).toContain("streak: activityStreak(");
    expect(milestone).toContain("streak: activityStreak(");
  });

  it("no unregistered module picks a streak variant directly", () => {
    const discovered = productionFiles().filter((rel) => {
      const src = read(rel);
      return (
        src.includes("flexibleStreak(") ||
        /\bcurrentStreak\(/.test(src) ||
        /from "[./]*streak"/.test(src)
      );
    });
    const unregistered = discovered.filter(
      (rel) =>
        !(rel in VARIANT_CALLERS) &&
        !USER_FACING_STREAK_PRODUCERS.includes(rel)
    );
    expect(
      unregistered,
      "a new streak caller must either use activityStreak (and join USER_FACING_STREAK_PRODUCERS) " +
        "or state, in VARIANT_CALLERS, which differently-labelled question it answers"
    ).toEqual([]);
  });
});
