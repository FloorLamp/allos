import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { detectMilestones } from "@/lib/milestones";
import * as streak from "@/lib/streak";
import { summarizePracticeWeeks } from "@/lib/trends-practices";

// The guard that replaces the #1398 variant-wiring scan. That issue's problem —
// two engines feeding the one word "streak" — dissolved when the word stopped
// being shown: #1935 cut the weekly-recap streak line, #1936 the per-supplement
// 🔥 chip, #1937 the Training Log "N-day streak" on all four surfaces, and
// #1939 the `streak:` / `adherence:` milestones. #1966 then extended the same
// ruling to the last analogue those four missed — the Trends Practices lens's
// "N-week streak" — so this scan covers whichever unit the run was counted in.
// It pins the state that replaced them, which is a narrower and more useful
// invariant: exactly ONE streak computation survives, and exactly ONE module may
// call it.
//
// The load-bearing half is the SURVIVOR pin. Cutting a display metric is easy to
// over-apply, and `currentStreak` is one grep away from the four things that were
// deleted — but it is the input to the coaching overtraining nudge ("You've
// trained N days in a row — a rest or light day will help you recover"). That is
// the app telling you to STOP: the inverse of a run to maintain, and a safety
// signal that must not be removed along with the vanity metrics it resembles.
// #1935, #1936, #1937 and #1939 each ask for this pin by name.
//
// A pure source scan (the profile-scoping / typed-route precedent): it fails CI
// when a new module reaches for a streak, so a new caller has to state, here,
// which "you have done too much of this in a row" question it answers.

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every production module allowed to import lib/streak, with the reason. Adding a
// row is a deliberate act: it means a new surface asks the overtraining question.
const STREAK_CALLERS: Record<string, string> = {
  "lib/coaching/engine.ts":
    'the overtraining nudge\'s "trained N days in a row" — strict, over hard-session ' +
    "dates, telling the user to rest",
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

describe("streak scope after the retirement (#1935/#1936/#1937/#1939/#1966)", () => {
  it("lib/streak exports currentStreak and nothing else", () => {
    // The rest-tolerant variants went with their last caller: flexibleStreak
    // existed only to power activityStreak, and activityStreak only to give the
    // Training tile, the recap and the milestone engine one shared number to print
    // under the word "streak". No surface prints that word any more.
    expect(Object.keys(streak).sort()).toEqual(["currentStreak"]);
  });

  it("only the coaching overtraining detector imports it", () => {
    const importers = productionFiles().filter((rel) =>
      /from "[@./][^"]*\/?streak"/.test(read(rel))
    );
    expect(
      importers.sort(),
      "a new lib/streak caller must state in STREAK_CALLERS which " +
        '"you have done too much of this in a row" question it answers — a run to ' +
        "MAINTAIN is not one of them (#1935/#1936/#1937/#1939)"
    ).toEqual(Object.keys(STREAK_CALLERS).sort());
  });

  it("the coaching overtraining reason still fires", () => {
    // The survivor pin carried by all four issues, exercised rather than grepped:
    // five consecutive hard-session days must still produce the rest nudge.
    const src = read("lib/coaching/engine.ts");
    expect(src).toContain("currentStreak(");
    expect(src).toContain("days in a row");
    const dates = [
      "2024-03-10",
      "2024-03-09",
      "2024-03-08",
      "2024-03-07",
      "2024-03-06",
    ];
    expect(streak.currentStreak("2024-03-10", dates)).toBe(5);
  });

  it("no production surface renders a user-facing streak label", () => {
    // The display sites #1935/#1936/#1937 removed plus the Practices lens #1966
    // did, pinned by their own copy so a reintroduction has to argue with this
    // test. The match is the WORD, not the unit: the Practices figure counted
    // weeks rather than days, which is how it survived the first sweep's
    // "N-day streak" reading of the family.
    //
    // Still scoped to the surfaces that HAD one: two domains keep their own
    // differently-shaped figures by owner ruling in #1966 — substance-use
    // abstinence days (clinically meaningful; the count IS the thing tracked)
    // and the mood check-in's ignored-day pause counter (a back-off mechanism,
    // which the attention doctrine treats as the system reducing contact).
    // Neither rewards maintaining a run, which is the actual test.
    const surfaces = [
      "app/(app)/training/OverviewSection.tsx",
      "app/(app)/training/TrainingLogView.tsx",
      "app/(app)/training/HistorySection.tsx",
      "app/(app)/training/RestrictedActivityView.tsx",
      "components/AdherenceRefill.tsx",
      "components/dashboard/WeeklyRecapWidget.tsx",
      "components/practices/PracticeTrends.tsx",
      "lib/trends-practices.ts",
    ];
    for (const rel of surfaces) {
      const rendered = read(rel)
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
      expect(rendered, `${rel} must not render a streak`).not.toMatch(
        /streak/i
      );
    }
  });

  it("practice consistency is a rate with no run in it (#1966)", () => {
    // The survivor pin for this domain, the half that matters: the weekly cadence
    // ledger and its met-week COUNT stay — only the run derived from them went.
    // Exercised rather than grepped, because "the streak is gone" and "the
    // tracking is gone" are one careless diff apart.
    const ledger = summarizePracticeWeeks([
      { verdict: "met" },
      { verdict: "at-ceiling" },
      { verdict: "under" },
      { verdict: "met" },
    ]);
    expect(ledger).toEqual({ weeks: 4, met: 3, rate: 0.75 });
    expect(Object.keys(ledger).some((k) => /streak/i.test(k))).toBe(false);
  });

  it("the milestone engine mints no run-shaped recognition", () => {
    // A profile that would have crossed every retired threshold at once gets only
    // the families that cannot be broken.
    const fired = detectMilestones({
      totalWorkouts: 500,
      completedGoals: [{ id: 1, title: "Run a 10k" }],
      fired: new Set<string>(),
    });
    expect(fired.every((m) => m.kind === "workouts" || m.kind === "goal")).toBe(
      true
    );
    expect(
      fired.some((m) => m.key.startsWith("streak:") || m.key.includes("streak"))
    ).toBe(false);
    expect(fired.some((m) => m.key.startsWith("adherence:"))).toBe(false);
  });
});
