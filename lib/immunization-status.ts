import { daysBetweenDateStr } from "./date";
import { normalizeCanonicalKey } from "./canonical-name";
import type { Sex } from "./types";
import {
  CATALOG,
  expandToComponents,
  vaccineByCode,
  type VaccineEntry,
  type VaccineGroup,
} from "./immunization-catalog";

// Pure, DB-free assessment of a profile's immunization status against the
// catalog schedule. Everything here is unit-tested; the page passes in the
// profile's age (months), sex, today's date, the stored dose records, and any
// interpreted antibody titers, and gets back a per-vaccine status plus a
// summary (what's next / overdue). No `today()` call lives here — the caller
// resolves "today" in the profile's timezone and passes it as `on`.

export type TiterStatus = "immune" | "non_immune" | "indeterminate";

export type VaccineStatus =
  | "complete" // series finished, or an immune titer is on record
  | "up_to_date" // on track / recent booster / seasonal dose current
  | "due" // recommended now, no dose recorded
  | "overdue" // past the recommended age/interval, no dose
  | "unknown" // age past the window but no record and no titer — can't tell
  | "not_recommended" // outside the age/sex window, or a record-only vaccine with no dose
  | "declined"; // terminal: the profile is not tracking / has declined this vaccine

// A per-profile, per-vaccine manual status override. `immune`
// counts the series complete regardless of dose count (the manual counterpart to
// titer-driven immunity); `declined` drops the vaccine from needs-attention and
// shows a muted terminal status. Stored in `immunization_overrides` and resolved
// PURELY by `applyOverride` below, so the page and the tests share one path.
export type OverrideKind = "immune" | "declined";

export interface VaccineOverride {
  vaccine: string; // catalog/combo code (matches VaccineAssessment.code)
  kind: OverrideKind;
  reason?: string | null;
  note?: string | null;
}

export interface ImmunizationRecordLite {
  vaccine: string; // stored catalog/combo code (or slug)
  date: string; // YYYY-MM-DD
}

export interface VaccineAssessment {
  code: string;
  name: string;
  abbrev: string;
  group: VaccineGroup;
  status: VaccineStatus;
  dosesReceived: number;
  dosesRequired: number | null;
  lastDate: string | null;
  detail: string; // short human status line
  nextLabel: string | null; // upcoming/next hint
  hasImmuneTiter: boolean;
  // The manual override in effect for this vaccine, if any. `immune` drove the
  // status to "complete"; `declined` drove it to "declined". Null when the status
  // is purely schedule/titer-derived. The UI reads this to label an
  // override-driven complete as "Immune (self-reported)".
  override: OverrideKind | null;
}

export interface ScheduleSummary {
  assessments: VaccineAssessment[];
  nextRecommended: VaccineAssessment | null;
  overdueCount: number;
  dueCount: number;
  unknownCount: number;
}

// Known numeric immune thresholds by antibody marker. anti-HBs ≥10 mIU/mL is
// the standard correlate of protection; most other titers are reported
// qualitatively (Immune / Reactive) and interpreted by keyword. Marker
// recognition is token-based (not a fixed spelling list) so lab variants like
// "Hepatitis B Surface Ab, Quantitative", "HBsAb", and "Anti-HBs" all resolve.
export function immuneThresholdFor(marker: string): number | undefined {
  const toks = new Set(
    normalizeCanonicalKey(marker).split(" ").filter(Boolean)
  );
  const isAntiHBs =
    toks.has("hbsab") ||
    toks.has("hbs") ||
    (toks.has("hepatitis") && toks.has("b") && toks.has("surface"));
  return isAntiHBs ? 10 : undefined;
}

// Age (months) past which a never-recorded childhood series reads "unknown"
// (adult, records likely lost) rather than "overdue" (a child genuinely behind).
const UNKNOWN_AFTER_MONTHS = 19 * 12;

// Minimum age (months) for the seasonal vaccines we track (influenza, COVID-19
// are recommended from 6 months) — below it they're not-recommended, not "due".
// Exported so the schedule grid tints the same age bands the engine assesses.
export const SEASONAL_MIN_MONTHS = 6;

// Interpret a titer/antibody value into immune / non-immune / indeterminate.
// Titers are often qualitative strings the biomarker layer doesn't parse to a
// number ("Immune", "Reactive", "Non-reactive", "1:160", "<5"). Keyword rules
// run first (negatives before positives so "non-reactive" isn't caught by
// "reactive"); a numeric threshold applies only when one is known for the marker.
export function titerImmuneStatus(
  value: string | null | undefined,
  opts?: { immuneAtLeast?: number }
): TiterStatus {
  if (value == null) return "indeterminate";
  const s = String(value).trim().toLowerCase();
  if (!s) return "indeterminate";
  // Explicit negatives, a value that LEADS with "no"/"none" ("No antibody
  // detected", "None detected", "No immunity"), OR a negation ("not"/"non") of
  // ANY positive term — so these read as non-immune and don't fall through to
  // the positive matcher and invert to "immune". Anchoring the bare "no" to the
  // start avoids mis-flagging a positive result that merely contains the word
  // (e.g. "Immune, no further testing needed").
  if (
    /^no(?:ne)?\b|\bnegative\b|\bneg\b|\babsent\b|nonreactive|nonimmune|(?:\bnot\b|\bnon\b|non-)[\s-]*(?:reactive|immune|detected|positive|protective|present)/.test(
      s
    )
  )
    return "non_immune";
  if (/(reactive|detected|immune|positive|\bpos\b|protective|present)/.test(s))
    return "immune";
  if (opts?.immuneAtLeast != null) {
    const num = parseFloat(s.replace(/[<>=]/g, ""));
    if (Number.isFinite(num)) {
      if (/^\s*</.test(s)) return "non_immune"; // "<10" is below threshold
      return num >= opts.immuneAtLeast ? "immune" : "non_immune";
    }
  }
  return "indeterminate";
}

// Add whole years to a YYYY-MM-DD date (pure; clamps Feb-29 → Feb-28).
function addYears(date: string, years: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  let [, ys, ms, ds] = m;
  const y = +ys + years;
  const mm = +ms;
  let dd = +ds;
  if (mm === 2 && dd === 29) dd = 28;
  return `${y}-${ms}-${String(dd).padStart(2, "0")}`;
}

function yearsSince(date: string, on: string): number | null {
  const days = daysBetweenDateStr(date, on);
  return days == null ? null : days / 365.25;
}

interface Ctx {
  ageMonths: number | null;
  sex: Sex | null;
  on: string;
  datesByCode: Map<string, string[]>;
  titerByMarker: Map<string, TiterStatus>;
}

function base(
  entry: VaccineEntry,
  dosesReceived: number,
  dosesRequired: number | null,
  lastDate: string | null,
  hasImmuneTiter: boolean,
  status: VaccineStatus,
  detail: string,
  nextLabel: string | null
): VaccineAssessment {
  return {
    code: entry.code,
    name: entry.name,
    abbrev: entry.abbrev,
    group: entry.group,
    status,
    dosesReceived,
    dosesRequired,
    lastDate,
    detail,
    nextLabel,
    hasImmuneTiter,
    override: null,
  };
}

// Resolve a manual override on top of a schedule-derived assessment (pure). An
// `immune` override forces the series to read complete regardless of dose count —
// the manual counterpart to a titer, so a partial series a person knows they're
// immune to stops nagging. A `declined` override is terminal: the vaccine leaves
// needs-attention and shows a muted "Declined" status. Returns the assessment
// unchanged when there is no override for it.
export function applyOverride(
  a: VaccineAssessment,
  override: VaccineOverride | undefined
): VaccineAssessment {
  if (!override) return a;
  if (override.kind === "declined")
    return {
      ...a,
      status: "declined",
      override: "declined",
      detail: "Not tracking / declined",
      nextLabel: null,
    };
  // immune: count the series complete. Keep the "titer confirmed" wording when a
  // real immune titer already backs it; otherwise mark it as self-reported.
  return {
    ...a,
    status: "complete",
    override: "immune",
    detail: a.hasImmuneTiter
      ? "Immune (titer confirmed)"
      : "Immune (self-reported)",
    nextLabel: null,
  };
}

// The status-filter buckets the master table exposes. Distinct from
// the raw VaccineStatus so a titer/override-driven completion filters as "immune"
// rather than plain "complete", and due/overdue collapse into "needs-attention".
export type ImmunizationFilter =
  | "needs-attention"
  | "up-to-date"
  | "complete"
  | "immune"
  | "declined"
  | "unknown"
  | "not-recommended";

// Bucket one assessment for the status filter (pure). Immune = complete that is
// driven by a titer or a manual immune override; complete = a finished dose
// series with no immunity shortcut.
export function filterCategoryFor(a: VaccineAssessment): ImmunizationFilter {
  switch (a.status) {
    case "declined":
      return "declined";
    case "overdue":
    case "due":
      return "needs-attention";
    case "unknown":
      return "unknown";
    case "up_to_date":
      return "up-to-date";
    case "complete":
      return a.override === "immune" || a.hasImmuneTiter
        ? "immune"
        : "complete";
    default:
      return "not-recommended";
  }
}

// Count how many of the (ascending) dose dates count as SEPARATE doses given a
// minimum spacing: the first dose always counts, and each later dose counts only
// if it's at least `minIntervalDays` after the previously credited dose. Doses
// logged closer than that (a duplicate entry, a same-visit re-record, or a dose
// given too early to "count") collapse into the prior one. Pure; used so two
// same-week entries don't read as a finished 2-dose series (#44 item 5).
export function creditedDoseCount(
  sortedDates: string[],
  minIntervalDays: number
): number {
  let credited = 0;
  let lastCredited: string | null = null;
  for (const d of sortedDates) {
    if (lastCredited == null) {
      credited++;
      lastCredited = d;
      continue;
    }
    const gap = daysBetweenDateStr(lastCredited, d);
    if (gap != null && gap >= minIntervalDays) {
      credited++;
      lastCredited = d;
    }
  }
  return credited;
}

function assessOne(entry: VaccineEntry, ctx: Ctx): VaccineAssessment {
  const dates = (ctx.datesByCode.get(entry.code) ?? [])
    .slice()
    .sort((a, b) => a.localeCompare(b));
  const rawCount = dates.length;
  const lastDate = rawCount ? dates[rawCount - 1] : null;
  const hasImmuneTiter = entry.antibodyMarkers.some(
    (m) => ctx.titerByMarker.get(m.toLowerCase()) === "immune"
  );
  const ageM = ctx.ageMonths;
  const sch = entry.schedule;

  // Minimum dose spacing (series / multi-dose one_time only). When set, credit
  // doses spaced closer than the minimum as ONE, and note the collapse gently.
  const minIntervalDays =
    sch.kind === "series" || sch.kind === "one_time"
      ? sch.minIntervalDays
      : undefined;
  const dosesReceived =
    minIntervalDays != null
      ? creditedDoseCount(dates, minIntervalDays)
      : rawCount;
  const collapsed = rawCount - dosesReceived;
  const mergedNote =
    collapsed > 0
      ? ` · ${collapsed} dose${collapsed > 1 ? "s" : ""} logged too close together, counted once`
      : "";
  // Append the gentle spacing note to an assessment's detail line (no-op when
  // nothing was collapsed).
  const note = (a: VaccineAssessment): VaccineAssessment =>
    mergedNote ? { ...a, detail: a.detail + mergedNote } : a;

  if (sch.kind === "series") {
    const required = sch.doses.length;
    if (hasImmuneTiter)
      return base(
        entry,
        dosesReceived,
        required,
        lastDate,
        true,
        "complete",
        "Immune (titer confirmed)",
        null
      );
    if (dosesReceived >= required)
      return note(
        base(
          entry,
          dosesReceived,
          required,
          lastDate,
          false,
          "complete",
          `${required}-dose series complete`,
          null
        )
      );
    const next = sch.doses[dosesReceived];
    if (ageM == null)
      return note(
        base(
          entry,
          dosesReceived,
          required,
          lastDate,
          false,
          dosesReceived > 0 ? "up_to_date" : "unknown",
          dosesReceived > 0
            ? `${dosesReceived} of ${required} doses`
            : "No record",
          `Next dose: ${next.label}`
        )
      );
    // Never dosed: an ADULT with no childhood record is genuinely "unknown" (we
    // can't tell if they were vaccinated); a child/adolescent past a dose age is
    // "overdue" — a real, surfaced gap. Split on adulthood, not on the series-end
    // age, so a 6-year-old missing MMR still shows overdue, not "no record".
    if (dosesReceived === 0 && ageM > UNKNOWN_AFTER_MONTHS) {
      // Issue #552: a childhood-only series with no routine adult catch-up
      // (rotavirus, childhood PCV/Hib) is age-inappropriate for an adult, not a
      // lost record — resolve it to `not_recommended` (ranked last, dropped from
      // the page table and the Upcoming/passport gap feeds) rather than
      // `unknown`. A series WITH an adult catch-up/booster (MMR, varicella, Tdap,
      // HepB/HepA…) keeps `unknown`, so a genuinely-missing adult dose still fires.
      if (entry.noAdultCatchup)
        return base(
          entry,
          0,
          required,
          null,
          false,
          "not_recommended",
          "Childhood series — no routine adult catch-up",
          null
        );
      return base(
        entry,
        0,
        required,
        null,
        false,
        "unknown",
        "No record on file",
        null
      );
    }
    if (ageM < next.minMonths)
      return note(
        base(
          entry,
          dosesReceived,
          required,
          lastDate,
          false,
          "up_to_date",
          `${dosesReceived} of ${required} doses`,
          `Next dose: ${next.label}`
        )
      );
    const overdue = ageM >= next.recommendedMonths + 3;
    return note(
      base(
        entry,
        dosesReceived,
        required,
        lastDate,
        false,
        overdue ? "overdue" : "due",
        `${dosesReceived} of ${required} doses`,
        `Dose ${dosesReceived + 1} ${overdue ? "overdue" : "due"} (${next.label})`
      )
    );
  }

  if (sch.kind === "booster") {
    const startM = sch.startAgeYears * 12;
    if (ageM != null && ageM < startM)
      return base(
        entry,
        dosesReceived,
        null,
        lastDate,
        hasImmuneTiter,
        "not_recommended",
        `From age ${sch.startAgeYears}`,
        null
      );
    // An immune titer for this booster's antigen (e.g. tetanus IgG) confirms
    // current protection — honor it like the series branch does, rather than
    // reading purely off the last dose date (keeps the two branches consistent).
    if (hasImmuneTiter)
      return base(
        entry,
        dosesReceived,
        null,
        lastDate,
        true,
        "up_to_date",
        "Immune (titer confirmed)",
        lastDate ? `Last dose ${lastDate}` : null
      );
    if (lastDate) {
      const yrs = yearsSince(lastDate, ctx.on);
      const due = addYears(lastDate, sch.intervalYears);
      if (yrs != null && yrs < sch.intervalYears)
        return base(
          entry,
          dosesReceived,
          null,
          lastDate,
          hasImmuneTiter,
          "up_to_date",
          `Boosted ${lastDate}`,
          `Next by ${due}`
        );
      return base(
        entry,
        dosesReceived,
        null,
        lastDate,
        hasImmuneTiter,
        "overdue",
        `Booster overdue (last ${lastDate})`,
        `Was due ${due}`
      );
    }
    // No booster ever recorded. A child/adolescent who has reached the booster
    // start age with no dose is a real, surfaced gap (overdue) — e.g. a
    // 12-year-old tracked since birth who is missing the adolescent Tdap; an
    // adult with no record is genuinely "unknown" (the historical dose was
    // likely just never entered). Same adulthood split the series branch uses.
    if (ageM != null && ageM <= UNKNOWN_AFTER_MONTHS)
      return base(
        entry,
        0,
        null,
        null,
        hasImmuneTiter,
        "overdue",
        "No booster on record",
        `Recommended from age ${sch.startAgeYears}`
      );
    return base(
      entry,
      0,
      null,
      null,
      hasImmuneTiter,
      "unknown",
      "No booster on record",
      `Booster every ${sch.intervalYears} y`
    );
  }

  if (sch.kind === "annual") {
    // Influenza / COVID-19 are recommended from 6 months — below that they're
    // not-recommended, not "due" (don't flag a 2-month-old for a flu shot).
    if (ageM != null && ageM < SEASONAL_MIN_MONTHS)
      return base(
        entry,
        dosesReceived,
        null,
        lastDate,
        hasImmuneTiter,
        "not_recommended",
        "From 6 months",
        null
      );
    if (lastDate) {
      const days = daysBetweenDateStr(lastDate, ctx.on);
      if (days != null && days <= 365)
        return base(
          entry,
          dosesReceived,
          null,
          lastDate,
          hasImmuneTiter,
          "up_to_date",
          `Received ${lastDate}`,
          null
        );
      return base(
        entry,
        dosesReceived,
        null,
        lastDate,
        hasImmuneTiter,
        "due",
        `Last dose ${lastDate}`,
        "Due this season"
      );
    }
    return base(
      entry,
      0,
      null,
      null,
      hasImmuneTiter,
      "due",
      "No dose this season",
      "Recommended each season"
    );
  }

  if (sch.kind === "one_time") {
    if (sch.sex && ctx.sex && ctx.sex !== sch.sex)
      return base(
        entry,
        dosesReceived,
        sch.doses,
        lastDate,
        hasImmuneTiter,
        "not_recommended",
        `${sch.sex} only`,
        null
      );
    const startM = sch.startAgeYears * 12;
    if (ageM != null && ageM < startM)
      return base(
        entry,
        dosesReceived,
        sch.doses,
        lastDate,
        hasImmuneTiter,
        "not_recommended",
        `From age ${sch.startAgeYears}`,
        null
      );
    if (dosesReceived >= sch.doses)
      return note(
        base(
          entry,
          dosesReceived,
          sch.doses,
          lastDate,
          hasImmuneTiter,
          "complete",
          sch.doses > 1 ? `${sch.doses} doses complete` : "Received",
          null
        )
      );
    // Past the routine catch-up window (e.g. HPV after 26): no longer routinely
    // recommended, so don't nag it as "due" — whether or not a partial series
    // was started (an incomplete HPV series at 40 isn't routinely completed).
    if (sch.endAgeYears != null && ageM != null && ageM > sch.endAgeYears * 12)
      return note(
        base(
          entry,
          dosesReceived,
          sch.doses,
          lastDate,
          hasImmuneTiter,
          "not_recommended",
          dosesReceived > 0
            ? `${dosesReceived} of ${sch.doses} doses · routine through age ${sch.endAgeYears}`
            : `Routine through age ${sch.endAgeYears}`,
          null
        )
      );
    if (dosesReceived > 0)
      return note(
        base(
          entry,
          dosesReceived,
          sch.doses,
          lastDate,
          hasImmuneTiter,
          "due",
          `${dosesReceived} of ${sch.doses} doses`,
          `Dose ${dosesReceived + 1} due`
        )
      );
    if (ageM == null)
      return base(
        entry,
        0,
        sch.doses,
        null,
        hasImmuneTiter,
        "unknown",
        "No record",
        `Recommended from age ${sch.startAgeYears}`
      );
    return base(
      entry,
      0,
      sch.doses,
      null,
      hasImmuneTiter,
      "due",
      "Recommended, not recorded",
      `From age ${sch.startAgeYears}`
    );
  }

  // record_only
  if (dosesReceived > 0)
    return base(
      entry,
      dosesReceived,
      null,
      lastDate,
      hasImmuneTiter,
      "up_to_date",
      `${dosesReceived} dose${dosesReceived > 1 ? "s" : ""} recorded`,
      lastDate ? `Last ${lastDate}` : null
    );
  return base(
    entry,
    0,
    null,
    null,
    hasImmuneTiter,
    "not_recommended",
    "Travel / risk-based — record if received",
    null
  );
}

// Build the code → dose-dates index, expanding combination shots to their
// component vaccine codes so one combo dose credits every component series.
export function datesByCodeFromRecords(
  records: ImmunizationRecordLite[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const r of records) {
    if (!r.date) continue;
    for (const code of expandToComponents(r.vaccine)) {
      const list = map.get(code);
      if (list) list.push(r.date);
      else map.set(code, [r.date]);
    }
  }
  return map;
}

// Interpreted titers by (lowercased) marker name. When several readings exist
// for a marker, an immune result wins.
export function titerMapFromReadings(
  readings: { marker: string; status: TiterStatus }[]
): Map<string, TiterStatus> {
  const map = new Map<string, TiterStatus>();
  for (const r of readings) {
    const key = r.marker.toLowerCase();
    const prev = map.get(key);
    if (prev === "immune") continue;
    if (!prev || r.status === "immune") map.set(key, r.status);
  }
  return map;
}

// ---- Auto dose-number labels (issue: immun review) ----
// A recorded dose gets an auto "Dose N" label from its chronological position in
// its vaccine's sequence, with " of M" appended when the vaccine is a fixed-count
// series. The user's explicit `dose_label` (e.g. "Booster") always wins. All pure
// so the history table and the per-vaccine detail share one numbering path.

// Total doses for a code when its schedule has a fixed count (primary series, or
// a fixed multi-dose one_time like HPV/Zoster); null for open-ended schedules
// (booster/annual/record_only) and combo/unknown codes, which then read "Dose N"
// with no "of M".
export function seriesLengthForCode(code: string): number | null {
  const entry = vaccineByCode(code);
  if (!entry) return null;
  const s = entry.schedule;
  if (s.kind === "series") return s.doses.length;
  if (s.kind === "one_time" && s.doses > 1) return s.doses;
  return null;
}

// Format a 1-based position into "Dose N" / "Dose N of M".
export function doseNumberLabel(
  position: number,
  total: number | null
): string {
  return total != null ? `Dose ${position} of ${total}` : `Dose ${position}`;
}

export interface DoseForLabeling {
  id: number;
  date: string;
  dose_label?: string | null;
}

// Resolve each dose's display label within a SINGLE vaccine's sequence: doses are
// ordered by date ascending (id as a stable tie-break), then numbered. A non-empty
// user `dose_label` wins over the auto number. Returns id → label.
export function resolveDoseLabels<T extends DoseForLabeling>(
  doses: T[],
  total: number | null
): Map<number, string> {
  const ordered = [...doses].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id - b.id
  );
  const out = new Map<number, string>();
  ordered.forEach((d, i) => {
    const explicit = d.dose_label?.trim();
    out.set(d.id, explicit ? explicit : doseNumberLabel(i + 1, total));
  });
  return out;
}

export interface DoseWithVaccine extends DoseForLabeling {
  vaccine: string; // stored code (combo or catalog)
}

// History-table variant: each stored dose is numbered within its OWN vaccine
// code's chronological sequence (a combo is numbered as itself, using its own
// series length — null for combos), matching "number per the vaccine whose series
// you're viewing". Returns id → label across all vaccines.
export function resolveDoseLabelsByVaccine<T extends DoseWithVaccine>(
  doses: T[]
): Map<number, string> {
  const byCode = new Map<string, T[]>();
  for (const d of doses) {
    const list = byCode.get(d.vaccine);
    if (list) list.push(d);
    else byCode.set(d.vaccine, [d]);
  }
  const out = new Map<number, string>();
  for (const [code, list] of byCode) {
    for (const [id, label] of resolveDoseLabels(
      list,
      seriesLengthForCode(code)
    ))
      out.set(id, label);
  }
  return out;
}

export function assessSchedule(
  records: ImmunizationRecordLite[],
  ageMonths: number | null,
  sex: Sex | null,
  on: string,
  titers: { marker: string; status: TiterStatus }[] = [],
  overrides: VaccineOverride[] = []
): ScheduleSummary {
  const ctx: Ctx = {
    ageMonths,
    sex,
    on,
    datesByCode: datesByCodeFromRecords(records),
    titerByMarker: titerMapFromReadings(titers),
  };
  const overrideByCode = new Map(overrides.map((o) => [o.vaccine, o]));
  const assessments = CATALOG.map((entry) =>
    applyOverride(assessOne(entry, ctx), overrideByCode.get(entry.code))
  );
  const overdue = assessments.filter((a) => a.status === "overdue");
  const due = assessments.filter((a) => a.status === "due");
  const unknown = assessments.filter((a) => a.status === "unknown");
  return {
    assessments,
    nextRecommended: overdue[0] ?? due[0] ?? null,
    overdueCount: overdue.length,
    dueCount: due.length,
    unknownCount: unknown.length,
  };
}

// True when another immunization in `items` shares this row's vaccine AND date, so a
// delete confirm keyed on "vaccine + date" alone (#534) would read identically for a
// duplicate-imported same-vaccine-same-date pair. The caller then folds in the
// distinguishing dose/provider so "delete X" names the right row. Pure + unit-tested.
export function immunizationHasDuplicateVaccineDate(
  items: readonly { id: number; vaccine: string; date: string }[],
  target: { id: number; vaccine: string; date: string }
): boolean {
  return items.some(
    (im) =>
      im.id !== target.id &&
      im.vaccine === target.vaccine &&
      im.date === target.date
  );
}
