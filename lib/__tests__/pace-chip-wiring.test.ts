import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #780 guard: every LIVE weekly-target chip surface must thread the paced `.pace`
// from getFrequencyTargetProgress into the chip, so none falls back to the legacy
// met/count colouring (which renders a fresh, not-started week's chip ROSE — the
// Monday-morning bug). WeeklyTargetChip keeps the legacy fallback for a hypothetical
// caller with no pace data, but no shipped surface may use it. This is a pure
// source-scan (like profile-scoping / telegram-chokepoint): it fails CI if a chip
// data-builder drops `pace`, or if a new chip surface appears without it.

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// The files that MAP frequency-target progress rows into WeeklyTarget/TargetChip/
// FrequencyTargetItem chip objects. Each must carry `pace:` in its mapping. A new
// chip surface adds its path here (and threads pace) — the render-site discovery
// check below fails closed until it does.
const CHIP_DATA_BUILDERS = [
  "components/dashboard/GoalsHabitsWidget.tsx", // dashboard Goals-and-habits
  "app/(app)/training/OverviewSection.tsx", // Training weekly routine
  "app/(app)/training/GoalsSection.tsx", // goals editor FrequencyTargets items
  "app/(app)/training/HistorySection.tsx", // journal week-summary targets
];

describe("#780 — weekly-target chips are pace-wired everywhere", () => {
  for (const file of CHIP_DATA_BUILDERS) {
    it(`${file} threads .pace into its chip mapping`, () => {
      const src = read(file);
      // Sanity: it really is a chip builder (maps per-week + met).
      expect(src).toMatch(/perWeek:/);
      expect(src).toMatch(/met:/);
      // The load-bearing assertion: pace is threaded, not dropped.
      expect(src).toMatch(/pace:/);
    });
  }

  it("the retired #760 'sky' hue is gone from the chip and the habit badge", () => {
    for (const file of [
      "components/WeeklyTargets.tsx",
      "app/(app)/nutrition/WeeklyHabits.tsx",
    ]) {
      expect(read(file)).not.toMatch(/sky-\d/);
    }
  });

  it("every <WeeklyTargets> render site either builds paced chips or forwards them", () => {
    // Fail-closed discovery: the ONLY files that render <WeeklyTargets> are the known
    // builders plus pure forwarders (they pass a pre-built, already-paced list through
    // without re-mapping). A new render site must be a builder in the list above or a
    // documented forwarder here — otherwise this list drifts and the test fails.
    const KNOWN_RENDER_SITES = new Set([
      "components/dashboard/GoalsHabitsWidget.tsx",
      "app/(app)/training/OverviewSection.tsx",
      "app/(app)/journal/JournalView.tsx", // renders weekSummary.targets (paced by HistorySection)
      "app/(app)/goals/FrequencyTargets.tsx", // forwards items (paced by GoalsSection)
    ]);
    // A forwarder must NOT itself re-map a frequency-target row without pace: it
    // either has no `perWeek:` mapping (pure forward) or includes pace.
    for (const file of KNOWN_RENDER_SITES) {
      const src = read(file);
      if (/perWeek:\s*\w+\.\w+/.test(src)) {
        expect(src).toMatch(/pace:/);
      }
    }
  });
});
