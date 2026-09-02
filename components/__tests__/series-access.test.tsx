import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { SeriesPoint, SeriesSummary } from "@/components/SeriesAccess";
import StandingSparkline from "@/components/dashboard/StandingSparkline";
import ActiveDaysStrip from "@/components/ActiveDaysStrip";
import FiberSymptomPanel from "@/components/FiberSymptomPanel";
import SupplementWeeklyAdherence from "@/components/SupplementWeeklyAdherence";
import BristolStoolPanel from "@/components/BristolStoolPanel";
import CareTrailBand from "@/components/illness/CareTrailBand";
import AdherenceCalendar from "@/components/medications/AdherenceCalendar";
import PracticeHeatmap from "@/components/practices/PracticeHeatmap";
import PracticeTrends from "@/components/practices/PracticeTrends";
import WeekSpine from "@/app/(app)/training/WeekSpine";
import StrengthStandardsLadder from "@/app/(app)/training/StrengthStandardsLadder";
import EnduranceDepthSuite from "@/app/(app)/training/EnduranceDepthSuite";
import FitnessCheckStrip from "@/app/(app)/training/FitnessCheckStrip";
import { buildActiveDaysStrip } from "@/lib/workout-heatmap";
import { buildBristolPanel } from "@/lib/bristol-stool";
import { buildFiberSymptomPanel } from "@/lib/fiber-symptom-panel";
import { buildAdherenceCalendar } from "@/lib/adherence-calendar";
import { buildProtocolHeatmap } from "@/lib/protocol-heatmap";
import { buildWeekSpine, weekSpineDaySummary } from "@/lib/training-week-spine";
import { practiceCadenceText } from "@/lib/practice";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
import { fmtWeight } from "@/lib/units";
import type { Swimlane } from "@/lib/care-trail-swimlane";
import type { StrengthLadderRow } from "@/lib/strength-ladder";
import type { StrengthStanding } from "@/lib/strength-standards";
import type { FitnessCheckModel } from "@/lib/fitness-check-model";
import type { SessionOverviewRollup } from "@/lib/session-overview";
import type { PracticeTrend } from "@/lib/queries/wellness";

// THE CHART CARRIES ITS OWN DATA ACCESS (#4760) — one assertion pattern, every
// adopter. `VisualizationDetails` restated each chart in a labelled fold; the fold is
// gone and the #3375 invariant is restated in the chart: (1) a visually hidden list
// names the whole series, (2) each mark whose value was only ever a hover or an AT
// name is a focusable target carrying that value, and (3) nothing on the surface is a
// visible "… details" control any more. Marks whose value is already PRINTED beside
// them (a month column's count) need no door, so a family may list no points.

type Text = string | RegExp;
type Family = {
  name: string;
  element: ReactElement;
  summary: string;
  items: Text[];
  points: { label: Text; role?: string }[];
};

const standing = (a: number, b: number) => (
  <StandingSparkline
    series={{
      points: [
        { date: "2026-08-25", value: a },
        { date: "2026-08-26", value: b },
      ],
      seriesKey: "metric:weight",
      stale: false,
      name: "Weight",
      pointLabel: (point) => `${point.value} kg · ${point.date}`,
      loneCaption: "One weight reading",
    }}
  />
);

const swimlane: Swimlane = {
  window: { start: "2026-08-01", end: "2026-08-31", spanDays: 31 },
  hasData: true,
  lanes: [
    {
      profileId: 7,
      episodes: [
        {
          episodeId: 1,
          situation: "Flu",
          ongoing: true,
          maxTempF: 101,
          leftPct: 10,
          widthPct: 30,
          visitMarkers: [
            { encounterId: 1, pct: 20, type: "Urgent care", dayNumber: 2 },
          ],
          courseBars: [
            {
              courseId: 1,
              medName: "Amoxicillin",
              leftPct: 15,
              widthPct: 40,
              overhang: true,
            },
          ],
        },
      ],
      visitMarkers: [
        { encounterId: 2, pct: 80, type: "Checkup", dayNumber: null },
      ],
    },
  ],
};

const standingOf = (e1rmKg: number, level: StrengthStanding["level"]) =>
  ({ e1rmKg, level }) as unknown as StrengthStanding;
const ladderRows: StrengthLadderRow[] = [
  {
    exercise: "Bench Press",
    placement: {
      current: standingOf(60, "novice"),
      currentPercent: 40,
      prior: standingOf(58.3, "beginner"),
      priorPercent: 35,
      moved: true,
    },
  },
];

const fitness = {
  coverage: { total: 2, measured: 1, fresh: 1, stale: 0, unmeasured: 1 },
  results: [
    { key: "vo2", label: "VO₂ max", measured: true, freshness: "current" },
    { key: "grip", label: "Grip", measured: false, freshness: "not-applicable" },
  ],
} as unknown as FitnessCheckModel;

const form = {
  recent: { sessions: 3, distanceKm: 12, durationMin: 90 },
  previous: { sessions: 2, distanceKm: 10, durationMin: 80 },
  distanceChangePercent: 20,
  durationChangePercent: 12,
} as unknown as SessionOverviewRollup;

const practice: PracticeTrend = {
  targetId: 1,
  identity: "red-light",
  name: "Red light therapy",
  perWeek: 3,
  perWeekMax: 5,
  weeks: [{ start: "2026-08-17", count: 2, verdict: "under" }],
  consistency: { weeks: 1, met: 0, rate: 0 },
  sessions: 2,
  duration: [],
};
const cadence = practiceCadenceText(3, 5);

const weekSpine = buildWeekSpine({
  start: "2026-08-24",
  today: "2026-08-26",
  rows: [{ date: "2026-08-25", type: "strength", count: 2 }],
});
const spineDay = weekSpineDaySummary(weekSpine.days[1]);

const FAMILIES: Family[] = [
  {
    name: "standing sparkline",
    element: standing(72, 73),
    summary: "Weight history",
    items: ["72 kg · 2026-08-25", "73 kg · 2026-08-26"],
    points: [{ label: "72 kg · 2026-08-25" }, { label: "73 kg · 2026-08-26" }],
  },
  {
    name: "active-days strip",
    element: (
      <ActiveDaysStrip
        data={buildActiveDaysStrip(
          [{ date: "2026-08-26", count: 1, minutes: 30 }],
          "2026-08-26",
          2
        )}
      />
    ),
    summary: "Recent activity days",
    items: ["2026-08-25 — no workouts", "2026-08-26 — 1 session · 30 min"],
    // The active day is already a link to its log; the empty day is the point.
    points: [{ label: "2026-08-25 — no workouts" }],
  },
  {
    name: "fiber × symptom panel",
    element: (
      <FiberSymptomPanel
        panel={buildFiberSymptomPanel({
          dates: ["2026-08-25"],
          gramsByDate: new Map([["2026-08-25", 12]]),
          symptoms: [{ date: "2026-08-25", symptom: "bloating", severity: 2 }],
        })}
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    ),
    summary: "Fiber and gut symptoms by day",
    items: [/^Aug 25 · 12 g · Bloating/],
    points: [{ label: /^Aug 25 · 12 g · Bloating/ }],
  },
  {
    name: "supplement weekly adherence",
    element: (
      <SupplementWeeklyAdherence
        days={[
          { date: "2026-08-25", due: 2, taken: 1, skipped: 0, isToday: false },
        ]}
        labels={{ "2026-08-25": "Tuesday, August 25" }}
      />
    ),
    summary: "Daily supplement adherence this week",
    items: ["Tuesday, August 25: 1 of 2 intended doses taken"],
    points: [{ label: "Tuesday, August 25: 1 of 2 intended doses taken" }],
  },
  {
    name: "Bristol panel",
    element: (
      <BristolStoolPanel
        panel={buildBristolPanel(
          ["2026-08-25"],
          [{ date: "2026-08-25", type: 1 }]
        )}
        formatPrefs={DEFAULT_FORMAT_PREFS}
      />
    ),
    summary: "Stool form by type and by day",
    items: [/^Type 1,.*: 1 of 1$/, /^Aug 25 · type 1/],
    points: [{ label: /^Type 1,.*: 1 of 1$/ }, { label: /^Aug 25 · type 1/ }],
  },
  {
    name: "care-trail band",
    element: (
      <CareTrailBand
        swimlane={swimlane}
        subjectById={
          new Map([
            [
              7,
              {
                name: "Riley",
                profile: {
                  id: 7,
                  name: "Riley",
                  photo_path: null,
                  photo_version: 0,
                },
              },
            ],
          ])
        }
        temperatureLabel="Past month"
      />
    ),
    summary: "Illness and visit timeline",
    items: [
      "Riley: Flu (ongoing)",
      "Riley: Visit — Urgent care (Day 2)",
      "Riley: Amoxicillin (continues past illness)",
      "Riley: Visit — Checkup",
    ],
    points: [
      { label: "Riley: Flu (ongoing)" },
      { label: "Riley: Visit — Urgent care (Day 2)" },
      { label: "Riley: Amoxicillin (continues past illness)" },
      { label: "Riley: Visit — Checkup" },
    ],
  },
  {
    name: "adherence calendar",
    element: (
      <AdherenceCalendar
        model={buildAdherenceCalendar([{ date: "2026-08-25", state: "taken" }])}
      />
    ),
    summary: "Adherence by day",
    items: ["2026-08-25 · Taken"],
    points: [{ label: "2026-08-25 · Taken" }],
  },
  {
    name: "week spine",
    element: <WeekSpine spine={weekSpine} />,
    summary: "Training day by day this week",
    items: [spineDay],
    // The day keeps its list semantics and gains the door.
    points: [{ label: spineDay, role: "listitem" }],
  },
  {
    name: "strength standards ladder",
    element: <StrengthStandardsLadder rows={ladderRows} weightUnit="kg" />,
    summary: "Bench Press standards ladder",
    items: [
      "Untrained",
      "Elite",
      `About 90 days ago: ${fmtWeight(58.3, "kg")}`,
      `Now: ${fmtWeight(60, "kg")} e1RM · Novice`,
    ],
    points: [
      { label: "Novice" },
      { label: `About 90 days ago: ${fmtWeight(58.3, "kg")}` },
      { label: `Now: ${fmtWeight(60, "kg")} e1RM · Novice` },
    ],
  },
  {
    name: "endurance zone coverage",
    element: (
      <EnduranceDepthSuite
        zones={{
          minutes: [10, 20, 0, 0, 5],
          totalMinutes: 35,
          easyMinutes: 30,
          hardMinutes: 5,
          easyPercent: 86,
        }}
        form={form}
        vo2={null}
        distanceUnit="km"
        adultClinicalContent={false}
      />
    ),
    summary: "Zone coverage this week",
    items: ["Zone 1: 10 min", "Zone 2: 20 min", "Zone 5: 5 min"],
    points: [{ label: "Zone 2: 20 min" }, { label: "Zone 3: 0 min" }],
  },
  {
    name: "fitness check strip",
    element: <FitnessCheckStrip model={fitness} />,
    summary: "Fitness tests",
    items: ["VO₂ max — current", "Grip — not measured"],
    points: [{ label: "VO₂ max — current" }, { label: "Grip — not measured" }],
  },
];

function expectText(texts: string[], expected: Text) {
  expect(
    texts.some((text) =>
      typeof expected === "string" ? text === expected : expected.test(text)
    ),
    `expected ${String(expected)} among ${JSON.stringify(texts)}`
  ).toBe(true);
}

describe("the chart carries its own data access (#4760)", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );

  it.each(FAMILIES.map((family) => [family.name, family] as const))(
    "%s: hidden series summary, focusable points, no fold",
    (_name, family) => {
      const { container } = render(family.element);
      const view = within(container);

      const list = view.getByRole("list", { name: family.summary });
      expect(list.classList.contains("sr-only")).toBe(true);
      const texts = within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent ?? "");
      for (const item of family.items) expectText(texts, item);

      for (const point of family.points) {
        const mark = view.getByRole(point.role ?? "img", { name: point.label });
        expect(mark.tabIndex).toBe(0);
        expect(mark.classList.contains("series-point")).toBe(true);
      }

      // The scan half: nothing visible says "… details", and no fold names one.
      expect(view.queryByText(/\bdetails\b/i)).toBeNull();
      for (const summary of container.querySelectorAll("summary")) {
        expect(summary.textContent ?? "").not.toMatch(/details/i);
      }
    }
  );

  // #4384's two practice mounts, absorbed: a pure deletion. The heatmap is a glance
  // surface (its `role="img"` sentence is its whole statement, per-day reading is the
  // ledger's job — no per-cell door), and the week cells already name themselves.
  it("the practice heatmap keeps its one summary and grows no doors", () => {
    const { container } = render(
      <PracticeHeatmap
        data={buildProtocolHeatmap(
          [{ date: "2026-08-29", count: 2 }],
          "2026-08-23",
          "2026-08-29"
        )}
      />
    );
    expect(
      screen.getByRole("img", {
        name: /^Practice activity from 2026-08-23 to 2026-08-29: 2 sessions across 1 active day/,
      })
    ).toBeTruthy();
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(container.querySelector("details")).toBeNull();
    expect(within(container).queryByText(/details/i)).toBeNull();
  });

  it("the practice trend's week cells are their own doors and nothing lists them twice", () => {
    const { container } = render(<PracticeTrends practice={practice} />);
    const week = screen.getByRole("img", {
      name: `Week of 2026-08-17 — 2 days logged of ${cadence}: Under floor`,
    });
    expect(week.tabIndex).toBe(0);
    expect(within(container).queryByText(/weekly details/i)).toBeNull();
    // The one fold left is the 26-week lens, not a values dump.
    const summaries = Array.from(container.querySelectorAll("summary")).map(
      (summary) => summary.textContent
    );
    expect(summaries).toEqual(["26-week trend"]);
  });
});

describe("SeriesAccess primitives", () => {
  it("an empty series renders no summary at all", () => {
    const { container } = render(<SeriesSummary label="Nothing" items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("a point is a focusable img by default and keeps a caller's own role", () => {
    render(
      <>
        <SeriesPoint label="12 g · Aug 25" />
        <SeriesPoint label="Mon — 2 strength" role="listitem" />
      </>
    );
    const img = screen.getByRole("img", { name: "12 g · Aug 25" });
    expect([img.tagName, img.tabIndex]).toEqual(["SPAN", 0]);
    expect(
      screen.getByRole("listitem", { name: "Mon — 2 strength" }).tabIndex
    ).toBe(0);
  });

  // jsdom applies no stylesheet, so the readout — the half of the door a sighted
  // reader uses — is proved on the compiled CSS: generated from the label, shown on
  // focus and on hover, hidden otherwise. The technique is
  // lib/__tests__/phone-only-compiled-css.test.ts's.
  it("the readout is generated from the label and shown on focus and hover", async () => {
    const REPO = process.cwd();
    const GLOBALS = path.join(REPO, "app/globals.css");
    const fixture = fs
      .readFileSync(GLOBALS, "utf8")
      .replace(
        '@import "tailwindcss";',
        '@import "tailwindcss" source(none);\n@source inline("series-point");'
      );
    const css = (
      await postcss([tailwindcss({ base: REPO })]).process(fixture, {
        from: GLOBALS,
      })
    ).css;
    const display = new Map<string, string>();
    let content = "";
    postcss.parse(css).walkRules(/\.series-point/, (rule) => {
      rule.walkDecls((declaration) => {
        if (declaration.prop === "content") content = declaration.value;
        if (declaration.prop === "display")
          display.set(rule.selector, declaration.value);
      });
    });
    expect(content).toBe("attr(aria-label)");
    expect(display.get(".series-point::after")).toBe("none");
    expect(
      [...display.entries()].filter(
        ([selector, value]) =>
          value === "block" && /:(focus|hover)::after/.test(selector)
      ).length
    ).toBeGreaterThanOrEqual(1);
  });
});
