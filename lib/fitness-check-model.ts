// Pure view model for the guided Fitness check (issue #834) — ONE computation the section
// component (and any future surface) formats over, so the completion %, per-domain
// percentile bars, and check-over-check deltas never drift ("one question, one
// computation", #221). DB-free: it takes the battery, the profile's recent check sessions,
// the LATEST AMBIENT natural-store reading per test (#1129), and the subject's
// sex/age/bodyweight, and returns a fully-derived model. Unit-tested in lib/__tests__.
//
// #1129 — THE READ SIDE OF THE WRITE-THROUGH DESIGN. The check writes every measured value
// THROUGH to its natural store (body_metrics / medical_records / exercise_sets); this model
// now READS BACK from those stores too. A single resolver picks, per test, the most recent
// value across BOTH sources — the session ledger entry AND the latest natural-store reading
// (ambient) — newest wins, tagged with PROVENANCE. So a synced VO2, a scale body-fat, or a
// logged heavy squat auto-counts as measured without re-entry, and completion / domain bars
// / deltas reflect it. A stored value older than the retest-cadence window is marked STALE
// (measured, but "re-check"), never silently counted as today's fitness. The provenance
// label ("from your check" vs "from Oura, 3 days ago") is the honesty guardrail — auto-count
// never presents synced data as a performed protocol.
//
// #1135 — the two isometric holds (dead hang / plank) carry a `self-norm` tier: a DISCLOSED
// -ROUGH band ladder (weak/fair/good/excellent) via lib/fitness-hold-norms, colored by
// favorability like the rest of the board, PLUS the retained personal delta — but never a
// fabricated percentile, never a contribution to the fitness-age headline or the percentile
// domain rollup.
//
// No new aggregate score (decided): the model exposes per-DOMAIN percentiles and per-test
// results; fitness age stays the one headline (surfaced from the endurance VO2 test here,
// but the app's canonical fitness age still lives in the healthspan pillars).

import {
  fitnessPercentile,
  fitnessAge,
  type FitnessPercentile,
  type FitnessAgeResult,
} from "@/lib/fitness-norms";
import {
  strengthStanding,
  strengthBadge,
  strengthStandingPercent,
  type StrengthBadge,
} from "@/lib/strength-standards";
import {
  bodyFavorability,
  evidenceFavorability,
} from "@/lib/fitness-favorability";
import { holdBand, type HoldBand } from "@/lib/fitness-hold-norms";
import { daysBetweenDateStr } from "@/lib/date";
import type { Sex } from "@/lib/types";
import {
  type FitnessTestDef,
  type FitnessTier,
  type FitnessDomain,
} from "@/lib/fitness-battery";

// The minimal session shape the model needs (a subset of FitnessAssessmentRecord), so the
// model stays DB-free and testable with plain fixtures.
export interface AssessmentLike {
  date: string;
  entries: {
    testKey: string;
    value: number;
    rawInput?: unknown;
  }[];
}

// The latest natural-store reading for a test (#1129), gathered by the DB layer
// (getAmbientFitnessReadings). `source` is the raw store source string ("oura", "withings",
// "manual", null for a plain quick-add, "logged set" for a journal set, …) — the resolver
// classifies it into a provenance kind + human label.
export interface AmbientReading {
  testKey: string;
  value: number;
  date: string;
  source: string | null;
  // For the standard-tier big lift, the lift the ambient e1RM came from (so the tile can
  // place it against strength standards without re-reading).
  liftName?: string | null;
}

export type ProvenanceKind = "check" | "synced" | "logged";

// Where the current value came from + how fresh it is — the #1129 honesty disclosure every
// surface renders. `stale` = older than the profile's retest-cadence window.
export interface FitnessProvenance {
  kind: ProvenanceKind;
  label: string; // "from your check" / "from Oura" / "from a logged set"
  sourceName: string | null; // "Oura" / "Withings" / "your journal" / null
  date: string;
  ageDays: number | null;
  stale: boolean;
}

// The rough-band result (#1135) for a self-norm test — a coarse band + a favorability
// position + the "rough" quality flag the surfaces disclose. NEVER a percentile.
export interface SelfNormResult {
  band: HoldBand;
  bandLabel: string;
  position: number; // 0–100 favorability
  quality: "rough";
  citation: string;
}

export interface FitnessTestResult {
  key: string;
  label: string;
  tier: FitnessTier;
  domain: FitnessDomain;
  unit: string;
  measured: boolean;
  value: number | null;
  lowerIsBetter: boolean;
  // norms tier
  percentile: FitnessPercentile | null;
  fitnessAge: FitnessAgeResult | null;
  // standard tier
  standing: StrengthBadge | null;
  standingLift: string | null;
  // self-norm tier (#1135)
  selfNorm: SelfNormResult | null;
  // The 0–100 FAVORABILITY (higher = healthier) the #1132 grid tile fills by — one number
  // per measured tile whose BASIS is the tier (percentile / strength position / distance
  // from range / distance from threshold / rough-band position). Null = no reference to
  // color by (unmeasured, or a self-trend residue colored by delta only).
  favorability: number | null;
  // provenance / freshness (#1129)
  provenance: FitnessProvenance | null;
  // check-over-check
  delta: number | null; // signed value change vs the prior check (canonical unit)
  improved: boolean | null; // whether the delta is an improvement (direction-aware)
  interpretation?: string;
}

export interface FitnessDomainSummary {
  domain: FitnessDomain;
  percentile: number | null; // best measured norms percentile in the domain
  measuredCount: number;
  totalCount: number;
}

export interface FitnessCheckModel {
  latestDate: string | null;
  priorDate: string | null;
  measuredCount: number;
  totalCount: number;
  results: FitnessTestResult[];
  domains: FitnessDomainSummary[];
  headlineFitnessAge: FitnessAgeResult | null; // from the endurance VO2 test, when measured
}

// The domain display order for the per-domain bars.
const DOMAIN_ORDER: FitnessDomain[] = [
  "endurance",
  "strength",
  "balance",
  "flexibility",
  "mobility",
  "body",
];

// Known device/sync sources → a human name for the provenance label. Anything else that
// isn't a manual/quick-add source is shown title-cased verbatim; a manual/null source (or a
// journal set) is "logged", not "synced".
const SOURCE_NAMES: Record<string, string> = {
  oura: "Oura",
  withings: "Withings",
  strava: "Strava",
  garmin: "Garmin",
  healthkit: "Apple Health",
  "health connect": "Health Connect",
  healthconnect: "Health Connect",
  fitbit: "Fitbit",
};

const MANUALISH = new Set(["manual", "", "logged set", "logged"]);

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

// Classify an ambient source string into a provenance kind + label (non-check paths only —
// a same-date write-through resolves to "check" via the newest-wins tie-break upstream).
function classifyAmbient(
  storeKind: "set" | "vital" | "body",
  source: string | null
): { kind: ProvenanceKind; sourceName: string | null; label: string } {
  const raw = (source ?? "").trim().toLowerCase();
  if (!MANUALISH.has(raw) && raw !== "") {
    const name = SOURCE_NAMES[raw] ?? titleCase(raw);
    return { kind: "synced", sourceName: name, label: `from ${name}` };
  }
  // manual / null / journal — logged, not synced.
  if (storeKind === "set") {
    return { kind: "logged", sourceName: "your journal", label: "from a logged set" };
  }
  return { kind: "logged", sourceName: "your journal", label: "from your data" };
}

function entryFor(a: AssessmentLike | null, key: string) {
  return a?.entries.find((e) => e.testKey === key) ?? null;
}

// Newest session (newest-first list) carrying an entry for a test, with its date.
function newestSessionEntryOnOrBefore(
  sessions: AssessmentLike[],
  key: string,
  beforeExclusive?: string
): { value: number; date: string; rawInput?: unknown } | null {
  for (const s of sessions) {
    if (beforeExclusive != null && s.date >= beforeExclusive) continue;
    const e = entryFor(s, key);
    if (e) return { value: e.value, date: s.date, rawInput: e.rawInput };
  }
  return null;
}

// Build the model for a battery + the profile's recent sessions (newest first) + the latest
// ambient natural-store reading per test + subject context.
//
// `sessions` is newest-first (getFitnessAssessments order). `ambient` is the latest store
// reading per test (may be empty). `todayISO` + `cadenceDays` drive the staleness gate; both
// default so existing pure fixtures stay terse.
export function buildFitnessCheckModel(
  battery: FitnessTestDef[],
  sessions: AssessmentLike[],
  ambient: AmbientReading[],
  sex: Sex | null,
  age: number | null,
  bodyweightKg: number | null,
  todayISO: string | null = null,
  cadenceDays = 180
): FitnessCheckModel {
  const ambientByKey = new Map(ambient.map((a) => [a.testKey, a]));
  const latestSession = sessions[0] ?? null;

  const results: FitnessTestResult[] = battery.map((def) => {
    const lowerIsBetter = !!def.lowerIsBetter;

    // ── Resolve the CURRENT value across the ledger + the natural store (#1129) ──
    const sessionEntry = newestSessionEntryOnOrBefore(sessions, def.key);
    const amb = ambientByKey.get(def.key) ?? null;

    // Candidates: the newest check-session entry (a "check") and the latest ambient
    // reading. Newest date wins; a same-date tie prefers the check (the write-through twin
    // carries the richer "you performed it" provenance and the same value).
    type Cur = {
      value: number;
      date: string;
      from: "check" | "ambient";
      rawInput?: unknown;
      liftName?: string | null;
    };
    const candidates: Cur[] = [];
    if (sessionEntry)
      candidates.push({
        value: sessionEntry.value,
        date: sessionEntry.date,
        from: "check",
        rawInput: sessionEntry.rawInput,
      });
    if (amb)
      candidates.push({
        value: amb.value,
        date: amb.date,
        from: "ambient",
        liftName: amb.liftName,
      });
    candidates.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // newest first
      return a.from === "check" ? -1 : 1; // tie → check
    });
    const current = candidates[0] ?? null;
    const value = current ? current.value : null;
    const measured = current != null;

    // Provenance + staleness.
    let provenance: FitnessProvenance | null = null;
    if (current) {
      const ageDays =
        todayISO != null ? daysBetweenDateStr(current.date, todayISO) : null;
      const stale = ageDays != null && ageDays > cadenceDays;
      if (current.from === "check") {
        provenance = {
          kind: "check",
          label: "from your check",
          sourceName: "your check",
          date: current.date,
          ageDays,
          stale,
        };
      } else {
        const c = classifyAmbient(def.store.kind, amb?.source ?? null);
        provenance = {
          kind: c.kind,
          label: c.label,
          sourceName: c.sourceName,
          date: current.date,
          ageDays,
          stale,
        };
      }
    }

    // ── Tier scoring over the resolved current value ──
    let percentile: FitnessPercentile | null = null;
    let fa: FitnessAgeResult | null = null;
    if (def.tier === "norms" && def.normsMarker && value != null) {
      percentile = fitnessPercentile(def.normsMarker, value, sex, age);
      fa = fitnessAge(def.normsMarker, value, sex, age);
    }

    let standing: StrengthBadge | null = null;
    let standingLift: string | null = null;
    let standingPct: number | null = null;
    if (def.tier === "standard" && value != null) {
      // The lift comes from the session raw input, or (for an ambient auto-count) the
      // ambient reading's liftName.
      const lift =
        (current?.rawInput as { lift?: string } | undefined)?.lift ??
        current?.liftName ??
        null;
      if (lift) {
        const full = strengthStanding(lift, value, sex, bodyweightKg);
        standing = strengthBadge(lift, value, sex, bodyweightKg);
        standingLift = lift;
        standingPct = strengthStandingPercent(full);
      }
    }

    let selfNorm: SelfNormResult | null = null;
    if (def.tier === "self-norm" && def.holdNorm && value != null) {
      const hb = holdBand(def.holdNorm, value, sex);
      if (hb) {
        selfNorm = {
          band: hb.band,
          bandLabel: hb.bandLabel,
          position: hb.position,
          quality: hb.quality,
          citation: hb.citation,
        };
      }
    }

    // Favorability (0–100, higher = healthier) — the tile fill, by tier.
    let favorability: number | null = null;
    if (value != null) {
      switch (def.tier) {
        case "norms":
          favorability = percentile?.percentile ?? null;
          break;
        case "standard":
          favorability = standingPct;
          break;
        case "body":
          favorability = bodyFavorability(def.key, value, sex);
          break;
        case "evidence":
          favorability = evidenceFavorability(def.key, value);
          break;
        case "self-norm":
          favorability = selfNorm?.position ?? null;
          break;
        case "self-trend":
          favorability = null; // colored by delta only
          break;
      }
    }

    // Check-over-check delta: compare the current value against the newest check STRICTLY
    // OLDER than it (so an ambient value newer than the last check compares honestly to
    // that check; a fresh check compares to the prior check).
    let delta: number | null = null;
    let improved: boolean | null = null;
    if (current) {
      const prev = newestSessionEntryOnOrBefore(sessions, def.key, current.date);
      if (prev) {
        delta = Math.round((value! - prev.value) * 100) / 100;
        if (delta === 0) improved = null;
        else improved = lowerIsBetter ? delta < 0 : delta > 0;
      }
    }

    return {
      key: def.key,
      label: def.label,
      tier: def.tier,
      domain: def.domain,
      unit: def.unit,
      measured,
      value,
      lowerIsBetter,
      percentile,
      fitnessAge: fa,
      standing,
      standingLift,
      selfNorm,
      favorability,
      provenance,
      delta,
      improved,
      interpretation: def.interpretation,
    };
  });

  const measuredCount = results.filter((r) => r.measured).length;

  const domains: FitnessDomainSummary[] = DOMAIN_ORDER.filter((d) =>
    battery.some((t) => t.domain === d)
  ).map((domain) => {
    const inDomain = results.filter((r) => r.domain === domain);
    // Percentile rollup stays NORMS-only (#1135): a rough self-norm band never blends into
    // a percentile aggregate.
    const pcts = inDomain
      .map((r) => r.percentile?.percentile)
      .filter((p): p is number => p != null);
    return {
      domain,
      percentile: pcts.length ? Math.max(...pcts) : null,
      measuredCount: inDomain.filter((r) => r.measured).length,
      totalCount: inDomain.length,
    };
  });

  const vo2 = results.find((r) => r.key === "vo2max");
  const priorSessionDate =
    sessions.find((s) => latestSession && s.date < latestSession.date)?.date ??
    null;

  return {
    latestDate: latestSession?.date ?? null,
    priorDate: priorSessionDate,
    measuredCount,
    totalCount: battery.length,
    results,
    domains,
    // Headline fitness age stays VO2-only — a rough self-norm band never moves it (#1135).
    headlineFitnessAge: vo2?.fitnessAge ?? null,
  };
}
