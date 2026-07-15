import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #780 guard: every LIVE weekly-target chip surface must thread the paced `.pace`
// from getFrequencyTargetProgress into the chip, so none falls back to the legacy
// met/count colouring (which renders a fresh, not-started week's chip ROSE — the
// Monday-morning bug). WeeklyTargetChip keeps the legacy fallback for a hypothetical
// caller with no pace data, but no shipped surface may use it. This is a pure
// source-scan (like profile-scoping / telegram-chokepoint): it fails CI if a chip
// data-builder drops `pace`, or if a new chip render site appears unregistered.

const ROOT = path.join(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

// Every file allowed to RENDER <WeeklyTargets> / <WeeklyTargetChip>: the builders
// above plus pure forwarders (they pass a pre-built, already-paced list through
// without re-mapping). The discovery test below walks the tree and requires the
// discovered set to EQUAL this one, so it can neither miss a new site nor go stale.
const KNOWN_RENDER_SITES = [
  "components/dashboard/GoalsHabitsWidget.tsx",
  "app/(app)/training/OverviewSection.tsx",
  "app/(app)/journal/JournalView.tsx", // renders weekSummary.targets (paced by HistorySection)
  "app/(app)/goals/FrequencyTargets.tsx", // forwards items (paced by GoalsSection)
];

// The component's own module renders <WeeklyTargetChip> internally (the row maps
// over chips) — it's the definition, not a consumer surface, so it's excluded from
// discovery rather than listed as a site.
const CHIP_DEFINITION = "components/WeeklyTargets.tsx";

// Directories that hold renderable UI source. lib/ holds no JSX surfaces.
const SCAN_DIRS = ["components", "app"];

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

// Every production file under SCAN_DIRS whose source renders the chip components.
function discoverRenderSites(): string[] {
  const sites: string[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (rel === CHIP_DEFINITION) continue;
      const text = fs.readFileSync(full, "utf8");
      if (/<WeeklyTargets\b|<WeeklyTargetChip\b/.test(text)) sites.push(rel);
    }
  }
  return sites.sort();
}

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
      CHIP_DEFINITION,
      "app/(app)/nutrition/WeeklyHabits.tsx",
    ]) {
      expect(read(file)).not.toMatch(/sky-\d/);
    }
  });

  it("every <WeeklyTargets> render site is discovered, registered, and paced", () => {
    // GENUINE fail-closed discovery: walk components/ + app/ for files that render
    // <WeeklyTargets> or <WeeklyTargetChip> and require the discovered set to EQUAL
    // the registered one. An unregistered new render site fails (wire `.pace` from
    // getFrequencyTargetProgress into its chips, then add it to KNOWN_RENDER_SITES —
    // and to CHIP_DATA_BUILDERS if it maps progress rows itself); a registered file
    // that no longer renders the chips fails too, so the list can't go stale.
    const discovered = discoverRenderSites();
    expect(
      discovered,
      "chip render sites drifted from KNOWN_RENDER_SITES: a NEW site must thread " +
        ".pace and be registered here; a REMOVED site must be deregistered"
    ).toEqual([...KNOWN_RENDER_SITES].sort());

    // A forwarder must NOT itself re-map a frequency-target row without pace: it
    // either has no `perWeek:` mapping (pure forward) or includes pace.
    for (const file of discovered) {
      const src = read(file);
      if (/perWeek:\s*\w+\.\w+/.test(src)) {
        expect(src, `${file} maps chip rows but drops .pace`).toMatch(/pace:/);
      }
    }
  });
});
