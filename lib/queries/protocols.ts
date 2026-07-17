// Read/derive layer for N-of-1 protocols (issue #161). Protocol CRUD reads plus
// the DB SEAM over the pure comparison engine: it gathers each declared outcome
// metric's profile-scoped time-series (biomarker readings, body metrics, or a
// derived index) and hands them to lib/protocol-compare, so the detail page's
// before/during panels are a thin formatter over ONE pure computation (the
// "one question, one computation" rule). Body-weight samples are converted to the
// login's display unit HERE (the units boundary), keeping the engine unit-agnostic.

import { db } from "../db";
import { getBiomarkerSeries, getCanonicalBiomarker } from "./medical";
import { getBodyMetrics } from "./metrics";
import {
  getFrequencyTargetProgress,
  type FrequencyTargetProgress,
} from "./training";
import { getBioAgeReadings } from "./derived";
import { getSleepRegularityTrend } from "./sleep";
import { kgTo } from "../units";
import type { WeightUnit } from "../settings";
import type { Protocol } from "../types";
import {
  FIXED_OUTCOME_METRICS,
  fixedMetricDef,
  outcomeMetricLabel,
  parseOutcomeKey,
  type OutcomeDirection,
} from "../protocol-metrics";
import {
  compareProtocol,
  type OutcomeSample,
  type OutcomeSeries,
  type ProtocolComparison,
} from "../protocol-compare";
import type { ProtocolWindowInput } from "../trend-annotations";
import type { Betterness } from "../protocol-compare";
import { daysBetweenDateStr } from "../date";
import { protocolPracticeLabel } from "../protocol-practice";
import { protocolHref, type AppRoute } from "../hrefs";
import { getUsedCanonicalNames } from "./medical";

interface ProtocolRow {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  notes: string | null;
  situation: string | null;
  outcome_keys: string;
  equipment_id: number | null;
  frequency_target_id: number | null;
  owns_frequency_target: number;
  intake_item_id: number | null;
  created_at: string;
}

// Parse the stored JSON outcome-key array defensively — a malformed blob yields an
// empty set rather than throwing.
function parseOutcomeKeys(v: string | null): string[] {
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function toProtocol(r: ProtocolRow): Protocol {
  return {
    id: r.id,
    name: r.name,
    start_date: r.start_date,
    end_date: r.end_date,
    notes: r.notes,
    situation: r.situation,
    outcomeKeys: parseOutcomeKeys(r.outcome_keys),
    equipment_id: r.equipment_id,
    frequency_target_id: r.frequency_target_id,
    owns_frequency_target: r.owns_frequency_target,
    intake_item_id: r.intake_item_id,
    created_at: r.created_at,
  };
}

// An option in the intervention intake-item picker (issue #660): the profile's
// supplements + medications, active first (so a paused item sinks). `kind` drives
// the surface a link points at (intakeHref). Profile-scoped.
export interface IntakeItemOption {
  id: number;
  name: string;
  kind: "supplement" | "medication";
}

export function getProtocolIntakeOptions(
  profileId: number
): IntakeItemOption[] {
  return db
    .prepare(
      `SELECT id, name, kind FROM intake_items
        WHERE profile_id = ?
        ORDER BY active DESC, name COLLATE NOCASE`
    )
    .all(profileId) as IntakeItemOption[];
}

// Resolve a protocol's linked intake item to its display ref (name + kind), or null
// when unlinked / the row was deleted. Profile-scoped so a leaked id yields null.
export function getProtocolIntakeItem(
  profileId: number,
  intakeItemId: number | null
): IntakeItemOption | null {
  if (intakeItemId == null) return null;
  const row = db
    .prepare(
      `SELECT id, name, kind FROM intake_items WHERE id = ? AND profile_id = ?`
    )
    .get(intakeItemId, profileId) as IntakeItemOption | undefined;
  return row ?? null;
}

// All protocols for a profile: ongoing (no end date) first, then most-recently
// started. Profile-scoped.
export function getProtocols(profileId: number): Protocol[] {
  const rows = db
    .prepare(
      `SELECT * FROM protocols WHERE profile_id = ?
       ORDER BY (end_date IS NOT NULL) ASC, start_date DESC, id DESC`
    )
    .all(profileId) as ProtocolRow[];
  return rows.map(toProtocol);
}

// Map of frequency_target_id → the name of the protocol that adopted it as its
// intervention (#580's link). Used by the Weekly-habits card to warn before untracking
// a habit that a protocol still measures (#748 item 6) — untracking nulls the link, so a
// protocol would silently lose its measurement in one tap. Only referenced targets
// appear; if several protocols share a target (unusual), the first by id wins the label.
export function getFrequencyTargetProtocolNames(
  profileId: number
): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT frequency_target_id, name FROM protocols
        WHERE profile_id = ? AND frequency_target_id IS NOT NULL
        ORDER BY id`
    )
    .all(profileId) as { frequency_target_id: number; name: string }[];
  const out = new Map<number, string>();
  for (const r of rows) {
    if (!out.has(r.frequency_target_id)) out.set(r.frequency_target_id, r.name);
  }
  return out;
}

// Every protocol as a chart-window input (name + start/end) for the trend
// annotations (issue #660). Ongoing protocols carry endDate null. Profile-scoped;
// no unit boundary (windows are date-only).
export function getProtocolWindows(profileId: number): ProtocolWindowInput[] {
  return getProtocols(profileId).map((p) => ({
    name: p.name,
    startDate: p.start_date,
    endDate: p.end_date,
  }));
}

// The windows of protocols that DECLARE a given outcome key as something they
// measure (issue #660): an outcome biomarker's own detail chart shades only the
// protocols targeting it, not every protocol the profile runs. `outcomeKey` is a
// namespaced metric key (e.g. "biomarker:LDL Cholesterol"). Profile-scoped.
export function getProtocolWindowsForOutcome(
  profileId: number,
  outcomeKey: string
): ProtocolWindowInput[] {
  return getProtocols(profileId)
    .filter((p) => p.outcomeKeys.includes(outcomeKey))
    .map((p) => ({
      name: p.name,
      startDate: p.start_date,
      endDate: p.end_date,
    }));
}

// A single protocol by id, scoped to the profile so a guessed id from another
// profile 404s. Null when absent.
export function getProtocol(profileId: number, id: number): Protocol | null {
  const row = db
    .prepare("SELECT * FROM protocols WHERE id = ? AND profile_id = ?")
    .get(id, profileId) as ProtocolRow | undefined;
  return row ? toProtocol(row) : null;
}

// True when any OTHER (still-ongoing) protocol for this profile declares the given
// situation label — used to decide whether ending/deleting a protocol should also
// deactivate the situation it activated (row-side-state rule: don't clobber a
// situation another live protocol still needs).
export function situationUsedByOtherProtocol(
  profileId: number,
  situation: string,
  exceptId: number
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM protocols
       WHERE profile_id = ? AND id != ? AND end_date IS NULL
         AND situation = ? COLLATE NOCASE LIMIT 1`
    )
    .get(profileId, exceptId, situation);
  return !!row;
}

// Usage-during-window for a protocol (issue #344): a pure join over `activities`
// within [start_date, end_date ?? today] that used the protocol's linked gear
// (activities.equipment_id) and/or logged the protocol's practice type. Counted as
// distinct training days, plus the last such date, for the "23 sessions · last 3
// days ago" line. No new table. Profile-scoped.
export interface ProtocolUsage {
  sessions: number;
  lastUsed: string | null;
}

export function getProtocolUsage(
  profileId: number,
  protocol: Protocol,
  today: string
): ProtocolUsage {
  const end = protocol.end_date ?? today;
  // The practice from the linked frequency target: an activity type (counted over
  // activities) or a food group (#580 — counted over food_log).
  let practiceType: string | null = null;
  let practiceFoodGroup: string | null = null;
  if (protocol.frequency_target_id != null) {
    const t = db
      .prepare(
        `SELECT scope_kind, scope_value FROM frequency_targets
          WHERE id = ? AND profile_id = ?`
      )
      .get(protocol.frequency_target_id, profileId) as
      { scope_kind: string; scope_value: string } | undefined;
    if (t && t.scope_kind === "type") practiceType = t.scope_value;
    else if (t && t.scope_kind === "food_group")
      practiceFoodGroup = t.scope_value;
  }

  // Food-group practice: distinct days the group was logged in the protocol window —
  // the "during this protocol" tally for a diet intervention (fatty fish for omega-3).
  if (practiceFoodGroup != null) {
    const rows = db
      .prepare(
        `SELECT DISTINCT date FROM food_log
          WHERE profile_id = ? AND date >= ? AND date <= ?
            AND group_key = ? AND servings > 0
          ORDER BY date`
      )
      .all(profileId, protocol.start_date, end, practiceFoodGroup) as {
      date: string;
    }[];
    return {
      sessions: rows.length,
      lastUsed: rows.length ? rows[rows.length - 1].date : null,
    };
  }

  if (protocol.equipment_id == null && practiceType == null)
    return { sessions: 0, lastUsed: null };

  const rows = db
    .prepare(
      `SELECT DISTINCT date FROM activities
        WHERE profile_id = ? AND date >= ? AND date <= ?
          AND (
            (? IS NOT NULL AND equipment_id = ?)
            OR (? IS NOT NULL AND type = ?)
          )
        ORDER BY date`
    )
    .all(
      profileId,
      protocol.start_date,
      end,
      protocol.equipment_id,
      protocol.equipment_id,
      practiceType,
      practiceType
    ) as { date: string }[];

  return {
    sessions: rows.length,
    lastUsed: rows.length ? rows[rows.length - 1].date : null,
  };
}

// The protocol's CONFIGURED practice (issue #344, generalized in #580): the linked
// frequency target's scope + value + per-week, for the adherence card and the edit
// form. A practice is an activity TYPE or a FOOD GROUP (both first-class protocol
// interventions); a region/group training target is not a "practice". Profile-scoped.
export interface ProtocolPractice {
  scopeKind: "type" | "food_group";
  value: string;
  perWeek: number;
}

export function getProtocolPractice(
  profileId: number,
  protocol: Protocol
): ProtocolPractice | null {
  if (protocol.frequency_target_id == null) return null;
  const t = db
    .prepare(
      `SELECT scope_kind, scope_value, per_week FROM frequency_targets
        WHERE id = ? AND profile_id = ?`
    )
    .get(protocol.frequency_target_id, profileId) as
    { scope_kind: string; scope_value: string; per_week: number } | undefined;
  if (!t || (t.scope_kind !== "type" && t.scope_kind !== "food_group"))
    return null;
  return {
    scopeKind: t.scope_kind,
    value: t.scope_value,
    perWeek: t.per_week,
  };
}

// Adherence for a protocol's practice (issue #344): the linked frequency target's
// CURRENT weekly progress, computed by the SAME getFrequencyTargetProgress the
// Weekly routine widget uses — one question, one computation, no parallel adherence
// engine. Null when the protocol has no practice link (or its target was removed).
export function getProtocolAdherence(
  profileId: number,
  protocol: Protocol
): FrequencyTargetProgress | null {
  if (protocol.frequency_target_id == null) return null;
  return (
    getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === protocol.frequency_target_id
    ) ?? null
  );
}

// An option in the outcome-metric picker: the fixed metrics plus the profile's
// tracked biomarkers. Grouped so the form can render headings.
export interface OutcomeOption {
  key: string;
  label: string;
  group: "Body & indices" | "Biomarkers";
}

export function getProtocolOutcomeOptions(profileId: number): OutcomeOption[] {
  const fixed: OutcomeOption[] = FIXED_OUTCOME_METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    group: "Body & indices",
  }));
  const biomarkers: OutcomeOption[] = getUsedCanonicalNames(profileId).map(
    (name) => ({
      key: `biomarker:${name}`,
      label: name,
      group: "Biomarkers",
    })
  );
  return [...fixed, ...biomarkers];
}

// Resolve one outcome key to its labeled series for a profile. Returns null when
// the key doesn't parse. Body weight is converted to the login's display unit.
function resolveOutcomeSeries(
  profileId: number,
  key: string,
  weightUnit: WeightUnit
): OutcomeSeries | null {
  const parsed = parseOutcomeKey(key);
  if (!parsed) return null;

  if (parsed.kind === "biomarker") {
    const cb = getCanonicalBiomarker(parsed.id);
    const samples: OutcomeSample[] = getBiomarkerSeries(profileId, parsed.id)
      .filter((r) => r.value_num != null)
      .map((r) => ({ date: r.date, value: r.value_num as number }));
    return {
      key,
      label: parsed.id,
      unit: cb?.unit ?? null,
      direction: (cb?.direction as OutcomeDirection | undefined) ?? "in_range",
      samples,
    };
  }

  if (parsed.kind === "body") {
    const def = fixedMetricDef(key);
    const rows = getBodyMetrics(profileId);
    const samples: OutcomeSample[] = [];
    for (const r of rows) {
      if (parsed.id === "weight" && r.weight_kg != null) {
        samples.push({ date: r.date, value: kgTo(r.weight_kg, weightUnit) });
      } else if (parsed.id === "resting_hr" && r.resting_hr != null) {
        samples.push({ date: r.date, value: r.resting_hr });
      } else if (parsed.id === "body_fat" && r.body_fat_pct != null) {
        samples.push({ date: r.date, value: r.body_fat_pct });
      }
    }
    return {
      key,
      label: def?.label ?? outcomeMetricLabel(key),
      unit: parsed.id === "weight" ? weightUnit : (def?.unit ?? null),
      direction: def?.direction ?? "neutral",
      samples,
    };
  }

  // index:*
  const def = fixedMetricDef(key);
  let samples: OutcomeSample[] = [];
  if (parsed.id === "phenoage") {
    samples = getBioAgeReadings(profileId).draws.map((d) => ({
      date: d.date,
      value: d.bioAge,
    }));
  } else if (parsed.id === "sri") {
    samples = getSleepRegularityTrend(profileId).map((t) => ({
      date: t.date,
      value: t.sri,
    }));
  }
  return {
    key,
    label: def?.label ?? outcomeMetricLabel(key),
    unit: def?.unit ?? null,
    direction: def?.direction ?? "neutral",
    samples,
  };
}

// The full before/during comparison for a protocol. `today` is the profile-local
// date (tz-window convention); the caller passes it so this stays a pure pass-
// through over compareProtocol once the series are gathered.
export function getProtocolComparison(
  profileId: number,
  protocol: Protocol,
  today: string,
  weightUnit: WeightUnit
): ProtocolComparison {
  const series = protocol.outcomeKeys
    .map((k) => resolveOutcomeSeries(profileId, k, weightUnit))
    .filter((s): s is OutcomeSeries => s != null);
  return compareProtocol(series, {
    startDate: protocol.start_date,
    endDate: protocol.end_date,
    today,
  });
}

// A compact summary of one ONGOING protocol for the dashboard widget (issue #660):
// days elapsed, this-week practice adherence, and the primary outcome's during-
// window trend. Every field is a FORMATTER over the SAME computations the detail
// page uses (getProtocolComparison / getProtocolAdherence / getProtocolPractice) —
// no parallel engine (one question, one computation).
export interface ActiveProtocolSummary {
  id: number;
  name: string;
  href: AppRoute;
  daysElapsed: number;
  adherence: {
    count: number;
    perWeek: number;
    met: boolean;
    label: string;
  } | null;
  primaryOutcome: {
    label: string;
    betterness: Betterness;
    framing: string;
    insufficient: boolean;
  } | null;
}

// Build the active-protocol summaries: every ongoing (end_date NULL) protocol,
// most-recently-started first (getProtocols order). `today` is the profile-local
// date; `weightUnit` threads the display unit into the outcome comparison (the units
// boundary lives in getProtocolComparison). Profile-scoped throughout.
export function getActiveProtocolSummaries(
  profileId: number,
  today: string,
  weightUnit: WeightUnit
): ActiveProtocolSummary[] {
  return getProtocols(profileId)
    .filter((p) => p.end_date == null)
    .map((protocol) => {
      const adherenceProgress = getProtocolAdherence(profileId, protocol);
      const practice = getProtocolPractice(profileId, protocol);
      const comparison = getProtocolComparison(
        profileId,
        protocol,
        today,
        weightUnit
      );
      const primary = comparison.outcomes[0] ?? null;
      // Inclusive elapsed days: a protocol started today reads "1 day in".
      const daysElapsed =
        (daysBetweenDateStr(protocol.start_date, today) ?? 0) + 1;
      return {
        id: protocol.id,
        name: protocol.name,
        href: protocolHref(protocol.id),
        daysElapsed,
        adherence:
          practice && adherenceProgress
            ? {
                count: adherenceProgress.count,
                perWeek: practice.perWeek,
                met: adherenceProgress.met,
                label: protocolPracticeLabel(
                  practice.scopeKind,
                  practice.value
                ),
              }
            : null,
        primaryOutcome: primary
          ? {
              label: primary.label,
              betterness: primary.betterness,
              framing: primary.framing,
              insufficient: primary.insufficient,
            }
          : null,
      };
    });
}
