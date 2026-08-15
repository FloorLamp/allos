// The fiber × GI-symptom read-together panel (issue #2788).
//
// The app can state your fiber intake (#976) and can record your GI symptoms, on
// different pages that never meet. This module assembles the one surface where they are
// READ TOGETHER: the daily fiber line with GI-symptom days marked on the same axis. It
// is a VIEW, deliberately not a correlation engine — the reader draws their own
// connection; the app draws none.
//
// STRUCTURALLY, not editorially (the lib/food-habit-observation.ts idiom): a panel day
// carries a date, a fiber figure, and the day's GI symptoms. There is no computed
// correlation, no sentence pairing the two series, no Finding, no dedupe key, no send —
// and no field a renderer could use to make any of those downstream. A rendered
// aggregate on a user-initiated surface, calm by construction.
//
// #2385 declaration — the panel invites behavior change, so it owes the triple:
//
// - WORKING: the panel is visited and fiber/symptom logging rates hold steady — people
//   consult it and keep recording honestly.
// - WRONG: symptom logging visibly bends toward chart-legible days (round-number
//   clustering, symptoms logged only when fiber was low — recording to confirm a theory
//   the chart suggested).
// - DECEPTIVE SUCCESS: fiber intake rising while GI-symptom days do not fall — the
//   chart read as "more fiber fixes it" driving supplement escalation past the point it
//   helps. The honest local check is the symptom-day rate over the same window the
//   fiber rise happened.

import { shiftDateStr } from "./date";

// The panel's window: four whole weeks, so a weekday-shaped rhythm is sampled the
// same number of times whichever day it renders on. The window lives HERE, not in
// the gather — lib/queries/nutrition.ts deliberately holds no window arithmetic
// (the #1909 boundary), and this module owns every shape decision the panel makes.
export const FIBER_SYMPTOM_PANEL_DAYS = 28;

// The window's dates for a profile-local today, oldest → newest.
export function fiberSymptomPanelDates(today: string): string[] {
  const dates: string[] = [];
  for (let i = FIBER_SYMPTOM_PANEL_DAYS - 1; i >= 0; i--)
    dates.push(shiftDateStr(today, -i));
  return dates;
}

// The GI subset of the symptom vocabulary this panel marks. A DECLARED list, not a
// domain filter: `SymptomDomain` is an order-only lever by its own contract (bloating
// sits under `cycle`), so reusing it here would cut against that contract and miss the
// members. Constipation joins when #2783 lands; Bristol 6–7 days (#2785) are a natural
// second marker once that observation exists. The panel test pins that every member
// resolves to a curated symptom slug, so a vocabulary rename cannot silently drop one.
export const GI_PANEL_SYMPTOMS: readonly string[] = [
  "diarrhea",
  "bloating",
  "abdominal_pain",
];

// One GI symptom logged on a panel day.
export interface PanelSymptom {
  symptom: string; // curated slug (GI_PANEL_SYMPTOMS member)
  severity: number; // 1–4
}

export interface FiberSymptomDay {
  date: string; // profile-local YYYY-MM-DD
  // The day's fiber grams (#976 basis: a FLOOR when not tracked), or null for a day
  // with no fiber signal at all — no servings logged, no tracked total, no confirmed
  // fiber dose. Null renders as an honest empty slot (#2258: a missing day occupies
  // space), never as a zero-gram claim of a fast nobody recorded.
  grams: number | null;
  // GI symptoms logged that day, worst-first. Empty for a symptom-free day.
  symptoms: PanelSymptom[];
}

export interface FiberSymptomPanel {
  // One entry per calendar day, oldest → newest, spanning the whole window.
  days: FiberSymptomDay[];
  // The scale the bars draw against: the window's highest fiber figure, floored at a
  // modest constant so a low-fiber week still renders as visibly low bars rather than
  // full-height ones.
  maxGrams: number;
}

// The scale floor: a window whose best day is a few grams should read as low, not as
// a full bar. 20 g sits under every adult AI band, so real intake still fills most of
// the strip.
const MIN_SCALE_GRAMS = 20;

export interface FiberSymptomPanelInput {
  // The window's dates, oldest → newest (fiberSymptomPanelDates above).
  dates: string[];
  // date → the day's fiber grams, absent/null for a no-signal day.
  gramsByDate: ReadonlyMap<string, number | null>;
  // Raw symptom rows in the window, any order; non-GI rows are filtered here so the
  // gather can pass what its reader returns without owning the panel's vocabulary.
  symptoms: readonly { date: string; symptom: string; severity: number }[];
}

// Assemble the panel. Pure — no DB, no clock; the gather resolves the window and the
// two series, this decides nothing beyond alignment, filtering, and scale.
export function buildFiberSymptomPanel(
  input: FiberSymptomPanelInput
): FiberSymptomPanel {
  const gi = new Set(GI_PANEL_SYMPTOMS);
  const byDate = new Map<string, PanelSymptom[]>();
  for (const row of input.symptoms) {
    if (!gi.has(row.symptom)) continue;
    const list = byDate.get(row.date) ?? [];
    list.push({ symptom: row.symptom, severity: row.severity });
    byDate.set(row.date, list);
  }
  for (const list of byDate.values()) {
    list.sort(
      (a, b) => b.severity - a.severity || a.symptom.localeCompare(b.symptom)
    );
  }

  const days: FiberSymptomDay[] = input.dates.map((date) => ({
    date,
    grams: input.gramsByDate.get(date) ?? null,
    symptoms: byDate.get(date) ?? [],
  }));

  const maxGrams = Math.max(MIN_SCALE_GRAMS, ...days.map((d) => d.grams ?? 0));
  return { days, maxGrams };
}

// Whether the panel has anything to read together: at least one fiber-bearing day AND
// at least one GI-symptom day in the window. With either series empty there is nothing
// to co-read, and the surface renders nothing rather than an empty exhortation.
export function fiberSymptomPanelHasSignal(panel: FiberSymptomPanel): boolean {
  return (
    panel.days.some((d) => (d.grams ?? 0) > 0) &&
    panel.days.some((d) => d.symptoms.length > 0)
  );
}
