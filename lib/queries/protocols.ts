// Read/derive layer for N-of-1 protocols (issue #161). Protocol CRUD reads plus
// the DB SEAM over the pure comparison engine: it gathers each declared outcome
// metric's profile-scoped time-series (biomarker readings, body metrics, or a
// derived index) and hands them to lib/protocol-compare, so the detail page's
// before/during panels are a thin formatter over ONE pure computation (the
// "one question, one computation" rule). Body-weight samples are converted to the
// login's display unit HERE (the units boundary), keeping the engine unit-agnostic.

import { db } from "../db";
import { getAllBiomarkerSeries, getCanonicalBiomarker } from "./medical";
import { getLogicalBodyMetricDailySeries } from "./logical-outcomes";
import {
  getFrequencyTargetProgress,
  type FrequencyTargetProgress,
} from "./frequency-targets";
import {
  getBiomarkerSeriesWithDerived,
  getDerivedBiomarkerReadings,
  getUsedCanonicalNamesWithDerived,
} from "./derived";
import { getSleepRegularityTrend } from "./sleep";
import { kgTo } from "../units";
import type { WeightUnit } from "../settings";
import type { Protocol } from "../types";
import {
  FIXED_OUTCOME_METRICS,
  fixedMetricDef,
  normalizeOutcomeKeys,
  outcomeMetricLabel,
  parseOutcomeKey,
  preferredOutcomeKey,
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
import {
  CADENCE_SCOPES,
  isCadenceScopeKind,
  type CadenceSource,
} from "../cadence";
import type { FrequencyPace } from "../goals";
import {
  protocolPracticeLabel,
  protocolPracticeNoun,
} from "../protocol-practice";
import { protocolHref, type AppRoute } from "../hrefs";
import {
  getPracticeDayCount,
  getPracticeSessions,
  getPracticeSpellingsMap,
  isPredictedPracticeDay,
  practiceSpellingsFor,
} from "./wellness";
import { practiceDurationPrefill } from "../practice";
import {
  biomarkerOutcomeOption,
  type OutcomeOption,
} from "../protocol-outcome-picker";
import { canonicalGroupKey, groupByCanonicalName } from "../biomarker-group";
import { preferredOutcomeKeyForBiomarker } from "../outcome-identity";
import { getRankedBiomarkerOptions } from "./biomarker-options";
import {
  buildProtocolHeatmap,
  type ProtocolDayUsage,
  type ProtocolHeatmap,
} from "../protocol-heatmap";

export type { OutcomeOption } from "../protocol-outcome-picker";

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
      ? normalizeOutcomeKeys(
          arr.filter((x): x is string => typeof x === "string")
        )
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
  const preferred = preferredOutcomeKey(outcomeKey);
  if (!preferred) return [];
  return getProtocols(profileId)
    .filter((p) => p.outcomeKeys.includes(preferred))
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

// Usage-during-window for a protocol (issues #344/#1583): event-row counts within
// [start_date, end_date ?? today]. Each scope reads its own ledger: activities,
// food_log, or practice_logs. Multi-session days remain multiple sessions.
export interface ProtocolUsage {
  sessions: number;
  lastUsed: string | null;
}

type ProtocolUsageScope =
  | { kind: "practice"; value: string }
  | { kind: "food_group"; value: string }
  | {
      kind: "activity";
      equipmentId: number | null;
      activityType: string | null;
    }
  | { kind: "none" };

// Which of this reader's three event ledgers a cadence SOURCE lands in — the
// third scope dispatcher (#2034), rebased onto the one registry so it cannot
// disagree with the weekly ledger about what a target measures.
//
// It stays its own table rather than reading a field off CADENCE_SCOPES, because
// protocol usage asks a genuinely different question: EVENT ROWS in a date window
// (a two-session day is two sessions), not a weekly count. What it must not do is
// fall through silently, which is what the old `if` chain did for every scope kind
// it hadn't been taught — so the mapping is exhaustive over `CadenceSource` and an
// eighth scope kind is a compile error here, not a protocol that quietly reports
// zero usage forever.
const PROTOCOL_USAGE_LEDGER: Record<
  CadenceSource,
  "practice" | "food_group" | "activity-type" | "unmeasurable"
> = {
  "practice-logs": "practice",
  "food-servings": "food_group",
  "activity-type": "activity-type",
  // A protocol's usage window counts SESSIONS it drove. A muscle region or a
  // mobility region is a property OF a session, not a session ledger of its own,
  // so such a protocol falls back to its equipment/activity link (below) exactly
  // as it always has.
  "exercise-sets": "unmeasurable",
  "mobility-moves": "unmeasurable",
  // A substance cap is a limit to stay under; "sessions of it during the protocol"
  // is not usage of the intervention, and counting it would read as adherence.
  "substance-ledger": "unmeasurable",
};

// Resolve the protocol intervention once, from its ALREADY-LOADED frequency target
// (null when it links none, or the link dangles). Pure, so the one-protocol and the
// batched gather below cannot disagree about what a protocol measures.
function usageScopeFor(
  protocol: Protocol,
  target: { scope_kind: string; scope_value: string } | null
): ProtocolUsageScope {
  let activityType: string | null = null;
  if (target && isCadenceScopeKind(target.scope_kind)) {
    const ledger =
      PROTOCOL_USAGE_LEDGER[CADENCE_SCOPES[target.scope_kind].source];
    if (ledger === "practice")
      return { kind: "practice", value: target.scope_value };
    if (ledger === "food_group")
      return { kind: "food_group", value: target.scope_value };
    if (ledger === "activity-type") activityType = target.scope_value;
  }

  if (protocol.equipment_id != null || activityType != null) {
    return {
      kind: "activity",
      equipmentId: protocol.equipment_id,
      activityType,
    };
  }
  return { kind: "none" };
}

// The frequency targets a set of protocols link, in ONE profile-scoped read.
function protocolTargetsById(
  profileId: number,
  protocols: readonly Protocol[]
): Map<number, { scope_kind: string; scope_value: string }> {
  const ids = [
    ...new Set(
      protocols
        .map((p) => p.frequency_target_id)
        .filter((id): id is number => id != null)
    ),
  ];
  const out = new Map<number, { scope_kind: string; scope_value: string }>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT id, scope_kind, scope_value FROM frequency_targets
        WHERE profile_id = ? AND id IN (${ids.map(() => "?").join(",")})`
    )
    .all(profileId, ...ids) as {
    id: number;
    scope_kind: string;
    scope_value: string;
  }[];
  for (const row of rows) {
    out.set(row.id, {
      scope_kind: row.scope_kind,
      scope_value: row.scope_value,
    });
  }
  return out;
}

function tallyByDate(
  into: Map<number, Map<string, number>>,
  protocolId: number,
  date: string,
  count: number
): void {
  let days = into.get(protocolId);
  if (!days) {
    days = new Map<string, number>();
    into.set(protocolId, days);
  }
  days.set(date, (days.get(date) ?? 0) + count);
}

// Usage-during-window for MANY protocols, in a bounded number of queries (#1655).
//
// The per-protocol shape issued its own scope lookup plus its own grouped ledger
// query, so /longevity's protocol list cost two queries per protocol the profile had
// EVER created — a page that gets slower purely as a function of how long someone has
// used the feature, recomputing windows that closed years ago. This reads each ledger
// ONCE over the union of the windows and slices per protocol in JS, the same shape
// getWellnessPractices already uses for its per-practice heatmaps.
//
// The single-protocol reader below delegates here, so there is exactly one definition
// of what a protocol's daily usage is.
export function getProtocolUsageByDayMap(
  profileId: number,
  protocols: readonly Protocol[],
  today: string,
  practiceSpellingsByProtocol?: ReadonlyMap<number, readonly string[]>
): Map<number, ProtocolDayUsage[]> {
  const out = new Map<number, ProtocolDayUsage[]>();
  if (protocols.length === 0) return out;

  const targets = protocolTargetsById(profileId, protocols);
  const scoped = protocols.map((protocol) => ({
    protocol,
    start: protocol.start_date,
    end: protocol.end_date ?? today,
    scope: usageScopeFor(
      protocol,
      protocol.frequency_target_id != null
        ? (targets.get(protocol.frequency_target_id) ?? null)
        : null
    ),
  }));

  // date → count, per protocol; emitted sorted at the end.
  const tallies = new Map<number, Map<string, number>>();
  const spanOf = (rows: typeof scoped) => ({
    start: rows.reduce(
      (min, r) => (r.start < min ? r.start : min),
      rows[0].start
    ),
    end: rows.reduce((max, r) => (r.end > max ? r.end : max), rows[0].end),
  });

  // ---- practice_logs -------------------------------------------------------------
  const practices = scoped.filter((r) => r.scope.kind === "practice");
  if (practices.length > 0) {
    const spellingsMap = getPracticeSpellingsMap(profileId);
    const perProtocol = new Map<number, Set<string>>();
    const all = new Set<string>();
    for (const row of practices) {
      const value = (row.scope as { kind: "practice"; value: string }).value;
      const spellings =
        practiceSpellingsByProtocol?.get(row.protocol.id) ??
        practiceSpellingsFor(spellingsMap, value);
      perProtocol.set(row.protocol.id, new Set(spellings));
      for (const s of spellings) all.add(s);
    }
    if (all.size > 0) {
      const values = [...all];
      const span = spanOf(practices);
      const rows = db
        .prepare(
          `SELECT date, practice, COUNT(*) AS count
             FROM practice_logs
            WHERE profile_id = ? AND practice IN (${values
              .map(() => "?")
              .join(",")})
              AND date >= ? AND date <= ?
            GROUP BY date, practice`
        )
        .all(profileId, ...values, span.start, span.end) as {
        date: string;
        practice: string;
        count: number;
      }[];
      for (const row of practices) {
        const mine = perProtocol.get(row.protocol.id)!;
        for (const r of rows) {
          if (r.date < row.start || r.date > row.end) continue;
          if (!mine.has(r.practice)) continue;
          tallyByDate(tallies, row.protocol.id, r.date, r.count);
        }
      }
    }
  }

  // ---- food_log ------------------------------------------------------------------
  const foods = scoped.filter((r) => r.scope.kind === "food_group");
  if (foods.length > 0) {
    const keys = [
      ...new Set(
        foods.map(
          (r) => (r.scope as { kind: "food_group"; value: string }).value
        )
      ),
    ];
    const span = spanOf(foods);
    const rows = db
      .prepare(
        `SELECT date, group_key, CAST(SUM(servings) AS INTEGER) AS count
           FROM food_log
          WHERE profile_id = ? AND date >= ? AND date <= ?
            AND group_key IN (${keys.map(() => "?").join(",")}) AND servings > 0
          GROUP BY date, group_key`
      )
      .all(profileId, span.start, span.end, ...keys) as {
      date: string;
      group_key: string;
      count: number;
    }[];
    for (const row of foods) {
      const key = (row.scope as { kind: "food_group"; value: string }).value;
      for (const r of rows) {
        if (r.group_key !== key) continue;
        if (r.date < row.start || r.date > row.end) continue;
        tallyByDate(tallies, row.protocol.id, r.date, r.count);
      }
    }
  }

  // ---- activities ----------------------------------------------------------------
  const acts = scoped.filter((r) => r.scope.kind === "activity");
  if (acts.length > 0) {
    const span = spanOf(acts);
    const scopes = acts.map(
      (r) =>
        r.scope as {
          kind: "activity";
          equipmentId: number | null;
          activityType: string | null;
        }
    );
    // The union of the lanes any of these protocols measures, so the one grouped read
    // still narrows to the rows a protocol could match rather than the whole ledger.
    const equipIds = [
      ...new Set(
        scopes
          .map((s) => s.equipmentId)
          .filter((id): id is number => id != null)
      ),
    ];
    const types = [
      ...new Set(
        scopes.map((s) => s.activityType).filter((t): t is string => t != null)
      ),
    ];
    const lanes = [
      ...(equipIds.length > 0
        ? [`equipment_id IN (${equipIds.map(() => "?").join(",")})`]
        : []),
      ...(types.length > 0
        ? [`type IN (${types.map(() => "?").join(",")})`]
        : []),
    ].join(" OR ");
    const rows = db
      .prepare(
        `SELECT date, equipment_id, type, COUNT(*) AS count FROM activities
          WHERE profile_id = ? AND date >= ? AND date <= ? AND (${lanes})
          GROUP BY date, equipment_id, type`
      )
      .all(profileId, span.start, span.end, ...equipIds, ...types) as {
      date: string;
      equipment_id: number | null;
      type: string;
      count: number;
    }[];
    for (const row of acts) {
      const scope = row.scope as {
        kind: "activity";
        equipmentId: number | null;
        activityType: string | null;
      };
      for (const r of rows) {
        if (r.date < row.start || r.date > row.end) continue;
        const matches =
          (scope.equipmentId != null && r.equipment_id === scope.equipmentId) ||
          (scope.activityType != null && r.type === scope.activityType);
        if (!matches) continue;
        tallyByDate(tallies, row.protocol.id, r.date, r.count);
      }
    }
  }

  for (const row of scoped) {
    const days = tallies.get(row.protocol.id);
    out.set(
      row.protocol.id,
      days
        ? [...days]
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => (a.date < b.date ? -1 : 1))
        : []
    );
  }
  return out;
}

export function getProtocolUsageByDay(
  profileId: number,
  protocol: Protocol,
  today: string,
  practiceSpellings?: readonly string[]
): ProtocolDayUsage[] {
  return (
    getProtocolUsageByDayMap(
      profileId,
      [protocol],
      today,
      practiceSpellings
        ? new Map([[protocol.id, practiceSpellings]])
        : undefined
    ).get(protocol.id) ?? []
  );
}

export function getProtocolUsage(
  profileId: number,
  protocol: Protocol,
  today: string,
  practiceSpellings?: readonly string[]
): ProtocolUsage {
  const days = getProtocolUsageByDay(
    profileId,
    protocol,
    today,
    practiceSpellings
  );
  return {
    sessions: days.reduce((sum, day) => sum + day.count, 0),
    lastUsed: days.at(-1)?.date ?? null,
  };
}

export function getProtocolHeatmap(
  profileId: number,
  protocol: Protocol,
  today: string,
  weekStart = 0
): ProtocolHeatmap {
  return getProtocolHeatmaps(profileId, [protocol], today, weekStart)[
    protocol.id
  ];
}

// Every listed protocol's heatmap, keyed by protocol id (#1655). The protocol list
// renders a heatmap per row — including for long-ended experiments, whose window is
// exactly what makes them worth looking at — so the list gathers here rather than
// asking per row: one bounded gather over the ledgers, not two queries per protocol
// the profile has ever created.
export function getProtocolHeatmaps(
  profileId: number,
  protocols: readonly Protocol[],
  today: string,
  weekStart = 0
): Record<number, ProtocolHeatmap> {
  const usage = getProtocolUsageByDayMap(profileId, protocols, today);
  return Object.fromEntries(
    protocols.map((protocol) => [
      protocol.id,
      buildProtocolHeatmap(
        usage.get(protocol.id) ?? [],
        protocol.start_date,
        protocol.end_date ?? today,
        weekStart
      ),
    ])
  );
}

// The protocol's CONFIGURED practice (issue #344, generalized in #580): the linked
// frequency target's scope + value + per-week, for the adherence card and the edit
// form. A practice is an activity TYPE or a FOOD GROUP (both first-class protocol
// interventions); a region/group training target is not a "practice". Profile-scoped.
export interface ProtocolPractice {
  scopeKind: "type" | "food_group" | "practice";
  value: string;
  perWeek: number;
  // The optional weekly ceiling (#1259) — a range ("3–5×/week"). Null for a bare floor.
  perWeekMax: number | null;
}

export function getProtocolPractice(
  profileId: number,
  protocol: Protocol
): ProtocolPractice | null {
  if (protocol.frequency_target_id == null) return null;
  const t = db
    .prepare(
      `SELECT scope_kind, scope_value, per_week, per_week_max FROM frequency_targets
        WHERE id = ? AND profile_id = ?`
    )
    .get(protocol.frequency_target_id, profileId) as
    | {
        scope_kind: string;
        scope_value: string;
        per_week: number;
        per_week_max: number | null;
      }
    | undefined;
  if (
    !t ||
    (t.scope_kind !== "type" &&
      t.scope_kind !== "food_group" &&
      t.scope_kind !== "practice")
  )
    return null;
  return {
    scopeKind: t.scope_kind,
    value: t.scope_value,
    perWeek: t.per_week,
    perWeekMax: t.per_week_max,
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

export function getProtocolOutcomeOptions(
  profileId: number,
  today: string
): OutcomeOption[] {
  const fixed: OutcomeOption[] = FIXED_OUTCOME_METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    group: "Body & indices",
    panel: null,
    searchTerms: [],
  }));
  const biomarkers = getRankedBiomarkerOptions(
    profileId,
    today,
    getUsedCanonicalNamesWithDerived(profileId)
  )
    .map((option) => option.name)
    .filter((name) => preferredOutcomeKeyForBiomarker(name) == null)
    .map(biomarkerOutcomeOption);
  return [...fixed, ...biomarkers];
}

// Resolve one outcome key to its labeled series for a profile. Returns null when
// the key doesn't parse. Body weight is converted to the login's display unit.
// Exported so the situation-window analytics (#1297) build the SAME series over the
// SAME registry — a new window source, not a forked resolver (#221).
export function resolveOutcomeSeries(
  profileId: number,
  key: string,
  weightUnit: WeightUnit
): OutcomeSeries | null {
  const canonicalKey = preferredOutcomeKey(key);
  if (!canonicalKey) return null;
  const parsed = parseOutcomeKey(canonicalKey);
  if (!parsed) return null;

  if (parsed.kind === "biomarker") {
    const cb = getCanonicalBiomarker(parsed.id);
    const samples: OutcomeSample[] = getBiomarkerSeriesWithDerived(
      profileId,
      parsed.id
    )
      .filter((r) => r.value_num != null)
      .map((r) => ({ date: r.date, value: r.value_num as number }));
    return {
      key: canonicalKey,
      label: parsed.id,
      unit: cb?.unit ?? null,
      direction: (cb?.direction as OutcomeDirection | undefined) ?? "in_range",
      samples,
    };
  }

  if (parsed.kind === "body") {
    const def = fixedMetricDef(canonicalKey);
    const samples: OutcomeSample[] = getLogicalBodyMetricDailySeries(
      profileId,
      parsed.id as "weight" | "resting_hr" | "body_fat",
      -1
    ).map((point) => ({
      date: point.date,
      value:
        parsed.id === "weight" ? kgTo(point.value, weightUnit) : point.value,
    }));
    return {
      key: canonicalKey,
      label: def?.label ?? outcomeMetricLabel(canonicalKey),
      unit: parsed.id === "weight" ? weightUnit : (def?.unit ?? null),
      direction: def?.direction ?? "neutral",
      samples,
    };
  }

  // index:*
  const def = fixedMetricDef(canonicalKey);
  let samples: OutcomeSample[] = [];
  if (parsed.id === "phenoage") {
    samples = getBiomarkerSeriesWithDerived(profileId, "PhenoAge")
      .filter((row) => row.value_num != null)
      .map((row) => ({ date: row.date, value: row.value_num as number }));
  } else if (parsed.id === "sri") {
    samples = getSleepRegularityTrend(profileId).map((t) => ({
      date: t.date,
      value: t.sri,
    }));
  }
  return {
    key: canonicalKey,
    label: def?.label ?? outcomeMetricLabel(canonicalKey),
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

// Detail-page picker data in one bounded gather: all offered outcomes are compared
// against this protocol's before/during windows so options with real data in BOTH
// windows can rank first and show a delta preview. Biomarkers are gathered through
// one bulk read rather than one getBiomarkerSeries query per option.
export function getProtocolOutcomePickerData(
  profileId: number,
  protocol: Protocol,
  today: string,
  weightUnit: WeightUnit
): {
  comparison: ProtocolComparison;
  options: OutcomeOption[];
} {
  const baseOptions = getProtocolOutcomeOptions(profileId, today);
  const baseKeys = new Set(baseOptions.map((option) => option.key));
  // A protocol can outlive the reading that originally made a biomarker
  // selectable. Keep every currently selected outcome in the editor so opening
  // and saving it never silently drops a historical choice.
  for (const key of normalizeOutcomeKeys(protocol.outcomeKeys)) {
    if (baseKeys.has(key)) continue;
    const parsed = parseOutcomeKey(key);
    if (parsed?.kind !== "biomarker") continue;
    baseOptions.push(biomarkerOutcomeOption(parsed.id));
    baseKeys.add(key);
  }
  const keys = normalizeOutcomeKeys([
    ...baseOptions.map((option) => option.key),
    ...protocol.outcomeKeys,
  ]);
  const hasBiomarkers = keys.some((key) => key.startsWith("biomarker:"));
  const storedByCanonical = hasBiomarkers
    ? groupByCanonicalName(getAllBiomarkerSeries(profileId))
    : new Map();
  const derived = hasBiomarkers ? getDerivedBiomarkerReadings(profileId) : [];

  const series = keys
    .map((key): OutcomeSeries | null => {
      const parsed = parseOutcomeKey(key);
      if (parsed?.kind !== "biomarker") {
        return resolveOutcomeSeries(profileId, key, weightUnit);
      }

      const canonical = parsed.id;
      const canonicalLower = canonical.toLowerCase();
      const rows = [
        ...(storedByCanonical.get(canonicalGroupKey(canonical)) ?? []),
        ...derived.filter(
          (row) =>
            (row.canonical_name ?? row.name).toLowerCase() === canonicalLower
        ),
      ].sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id
      );
      const cb = getCanonicalBiomarker(canonical);
      return {
        key,
        label: canonical,
        unit: cb?.unit ?? null,
        direction:
          (cb?.direction as OutcomeDirection | undefined) ?? "in_range",
        samples: rows
          .filter((row) => row.value_num != null)
          .map((row) => ({ date: row.date, value: row.value_num as number })),
      };
    })
    .filter((item): item is OutcomeSeries => item != null);

  const allComparison = compareProtocol(series, {
    startDate: protocol.start_date,
    endDate: protocol.end_date,
    today,
  });
  const comparedByKey = new Map(
    allComparison.outcomes.map((outcome) => [outcome.key, outcome])
  );
  const options = baseOptions.map((option) => {
    const outcome = comparedByKey.get(option.key);
    if (
      !outcome ||
      outcome.insufficient ||
      outcome.baseline.mean == null ||
      outcome.intervention.mean == null ||
      outcome.meanDelta == null
    ) {
      return option;
    }
    return {
      ...option,
      preview: {
        beforeMean: outcome.baseline.mean,
        duringMean: outcome.intervention.mean,
        meanDelta: outcome.meanDelta,
        unit: outcome.unit,
        beforeN: outcome.baseline.n,
        duringN: outcome.intervention.n,
      },
    };
  });

  return {
    options,
    comparison: {
      ...allComparison,
      outcomes: normalizeOutcomeKeys(protocol.outcomeKeys)
        .map((key) => comparedByKey.get(key))
        .filter((outcome): outcome is NonNullable<typeof outcome> => !!outcome),
    },
  };
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
    // The optional weekly ceiling (#1259) — a range; null for a bare floor.
    perWeekMax: number | null;
    // The THREE-state weekly verdict (#748): behind / on-pace / met, prorated by how
    // much of the week has elapsed. `met` alone is a two-state answer, and rendering
    // it as "Behind" is the pre-#748 bug — carry the pace through so the dashboard
    // widget renders the SAME verdict as the wellness card and the detail page
    // (#2008).
    pace: FrequencyPace;
    // At/above the ceiling — the calm "that's plenty" state (#1259).
    atCeiling: boolean;
    label: string;
    // The counting noun for this scope ("day"/"serving"/"session").
    noun: string;
  } | null;
  // All three practice scopes are actionable (#1584). The dashboard passes this
  // same model to ProtocolLogButton as the detail page.
  practice: ProtocolPractice | null;
  practiceTodayCount: number;
  // Whether today is one of the wellness practice's inferred rhythm days (#2188)
  // — the calm "usually a session day" note beside the log button. Always false
  // for non-practice scopes and whenever no rhythm exists (#558: no pattern
  // renders nothing). Data, not dueness (#1505).
  practiceUsuallyToday: boolean;
  // Where the widget's inline duration stepper STARTS (#2204) — `practiceDurationPrefill`
  // over the identity's last logged session, the same pure resolution the Wellness card,
  // the quick sheet, and the protocol detail page read. Null for a non-practice scope and
  // for a practice with no history: blank is a real answer, and the app does not invent a
  // duration. The widget mounts the SAME ProtocolLogButton the detail page does, so
  // leaving this out would have left the dashboard's one-tap the last log that discards
  // what it never showed.
  practicePreviousDurationMin: number | null;
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
  const spellingsByIdentity = getPracticeSpellingsMap(profileId);
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
                perWeekMax: adherenceProgress.per_week_max,
                pace: adherenceProgress.pace,
                atCeiling: adherenceProgress.atCeiling,
                label: protocolPracticeLabel(
                  practice.scopeKind,
                  practice.value
                ),
                noun: protocolPracticeNoun(practice.scopeKind),
              }
            : null,
        practice,
        practiceTodayCount:
          practice?.scopeKind === "practice"
            ? getPracticeDayCount(
                profileId,
                practice.value,
                today,
                practiceSpellingsFor(spellingsByIdentity, practice.value)
              )
            : 0,
        practiceUsuallyToday:
          practice?.scopeKind === "practice" &&
          isPredictedPracticeDay(profileId, practice.value, today) === true,
        // One LIMIT-1 indexed read per practice-scoped active protocol, over the
        // spellings this gather already resolved — the same bounded shape as the
        // today-count beside it.
        practicePreviousDurationMin:
          practice?.scopeKind === "practice"
            ? practiceDurationPrefill(
                getPracticeSessions(
                  profileId,
                  practice.value,
                  1,
                  undefined,
                  practiceSpellingsFor(spellingsByIdentity, practice.value)
                )
              )
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
