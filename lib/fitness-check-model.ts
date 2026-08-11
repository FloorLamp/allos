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
import { freshnessState, type FreshnessState } from "@/lib/freshness";
import { fitnessFreshnessDays } from "@/lib/fitness-freshness";
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
// "manual", null for a plain quick-add, "logged set" for a training log set, …) — the resolver
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
// surface renders.
//
// #2025: freshness is resolved against the test's OWN declared policy
// (lib/fitness-freshness), not one global cadence. `freshnessDays` is the interval that
// applied, so a surface can say which clock it used; `freshness` is the shared verdict
// (lib/freshness) and `stale` is its boolean twin, kept because every existing tile reads
// it and it means exactly `freshness === "due"`.
export interface FitnessProvenance {
  kind: ProvenanceKind;
  label: string; // "from your check" / "from Oura" / "from a logged set"
  sourceName: string | null; // "Oura" / "Withings" / "your training log" / null
  date: string;
  ageDays: number | null;
  freshness: FreshnessState;
  freshnessDays: number;
  stale: boolean;
}

// Coverage at whole-check and per-domain level (#2025). The four counts are separate
// facts and are never collapsed: `measured` answers "is there any historical value" and
// `fresh` answers "is there a CURRENT value", which is the distinction the old
// `measuredCount` flattened into one number that completion copy then called "recent".
//   measured = fresh + stale, and measured + unmeasured = total.
export interface FitnessCoverage {
  total: number;
  measured: number;
  fresh: number;
  stale: number;
  unmeasured: number;
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
  // The test's freshness verdict (#2025), lifted off the provenance so coverage counting
  // and any surface read it without unwrapping. "not-applicable" for an unmeasured test —
  // an unmeasured test is not stale — and for a measured one the model could not date.
  freshness: FreshnessState;
  // check-over-check
  delta: number | null; // signed value change vs the prior check (canonical unit)
  improved: boolean | null; // whether the delta is an improvement (direction-aware)
  interpretation?: string;
}

export interface FitnessDomainSummary {
  domain: FitnessDomain;
  // #2025 — RENAMED from `percentile`. This is the BEST norms-backed result in the domain,
  // not a domain percentile: a domain with one excellent and one weak test used to be
  // summarized by the excellent one under an undifferentiated name, and every surface
  // repeated that. The field, the bar label and the docs now all say "best".
  bestPercentile: number | null;
  // The LOWEST norms-backed percentile in the domain, so a surface can show the spread
  // instead of implying the best result represents the whole domain. Equal to
  // `bestPercentile` when only one norms test is measured; null when none is.
  lowestPercentile: number | null;
  // How many measured tests in the domain carry a norms percentile at all — the honest
  // denominator behind "best of". Rough self-norm bands and non-norm tiers are excluded
  // (#1135): they never enter a percentile aggregate.
  normsCount: number;
  measuredCount: number;
  totalCount: number;
  // Fresh/stale/unmeasured split for the domain (#2025).
  coverage: FitnessCoverage;
}

export interface FitnessCheckModel {
  latestDate: string | null;
  priorDate: string | null;
  // Tests with ANY value, however old — the historical-coverage count. Kept under its old
  // name and meaning; `coverage.fresh` is the one a "current" claim may rest on.
  measuredCount: number;
  totalCount: number;
  // Whole-check fresh / stale / unmeasured split (#2025).
  coverage: FitnessCoverage;
  results: FitnessTestResult[];
  domains: FitnessDomainSummary[];
  headlineFitnessAge: FitnessAgeResult | null; // from the endurance VO2 test, when measured
  // The VO2 fitness age from the check STRICTLY BEFORE the one the headline reflects
  // (#1307), so the battery-completion finale can say "fitness age 34 (was 36)". Null
  // when there's no prior VO2 check (or VO2 isn't measured). One computation — the same
  // fitnessAge() the headline uses, over the prior check's value.
  priorHeadlineFitnessAge: FitnessAgeResult | null;
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
// training log set) is "logged", not "synced".
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
  // manual / null / training log — logged, not synced.
  if (storeKind === "set") {
    return {
      kind: "logged",
      sourceName: "your training log",
      label: "from a logged set",
    };
  }
  return {
    kind: "logged",
    sourceName: "your training log",
    label: "from your data",
  };
}

// The fresh / stale / unmeasured split over a set of results (#2025) — the ONE counting
// rule the whole check and every domain share, so a domain's numbers always sum to the
// check's. A measured test the model could not date counts as measured but not fresh:
// it has a value and no evidence that value is current.
function coverageOf(results: readonly FitnessTestResult[]): FitnessCoverage {
  let measured = 0;
  let fresh = 0;
  let stale = 0;
  for (const r of results) {
    if (!r.measured) continue;
    measured++;
    if (r.freshness === "current") fresh++;
    else if (r.freshness === "due") stale++;
  }
  return {
    total: results.length,
    measured,
    fresh,
    stale,
    unmeasured: results.length - measured,
  };
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

    // Provenance + freshness. The interval is the TEST'S OWN declared policy (#2025), not
    // one global cadence: a continuously-measured body value and a performed protocol do
    // not have the same useful freshness, and the exception is declared in the registry
    // rather than inferred here or in a component.
    const freshnessDays = fitnessFreshnessDays(def.key, cadenceDays);
    let provenance: FitnessProvenance | null = null;
    let freshness: FreshnessState = "not-applicable";
    if (current) {
      const ageDays =
        todayISO != null ? daysBetweenDateStr(current.date, todayISO) : null;
      freshness = freshnessState(ageDays, freshnessDays);
      const stale = freshness === "due";
      if (current.from === "check") {
        provenance = {
          kind: "check",
          label: "from your check",
          sourceName: "your check",
          date: current.date,
          ageDays,
          freshness,
          freshnessDays,
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
          freshness,
          freshnessDays,
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
      const prev = newestSessionEntryOnOrBefore(
        sessions,
        def.key,
        current.date
      );
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
      freshness,
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
    // a percentile aggregate. #2025 keeps the max but stops calling it "the domain
    // percentile": it is the BEST norms result, carried alongside the lowest and the
    // count so no surface can present it as the whole domain.
    const pcts = inDomain
      .map((r) => r.percentile?.percentile)
      .filter((p): p is number => p != null);
    return {
      domain,
      bestPercentile: pcts.length ? Math.max(...pcts) : null,
      lowestPercentile: pcts.length ? Math.min(...pcts) : null,
      normsCount: pcts.length,
      measuredCount: inDomain.filter((r) => r.measured).length,
      totalCount: inDomain.length,
      coverage: coverageOf(inDomain),
    };
  });

  const vo2 = results.find((r) => r.key === "vo2max");
  const priorSessionDate =
    sessions.find((s) => latestSession && s.date < latestSession.date)?.date ??
    null;

  // Prior-check headline fitness age (#1307): the VO2 fitness age from the check strictly
  // before the current VO2's date, via the SAME fitnessAge() the headline uses. Null when
  // VO2 isn't measured, has no norms marker, or there's no earlier VO2 check.
  let priorHeadlineFitnessAge: FitnessAgeResult | null = null;
  const vo2Def = battery.find((d) => d.key === "vo2max");
  if (vo2Def?.normsMarker && vo2?.value != null) {
    const curEntry = newestSessionEntryOnOrBefore(sessions, "vo2max");
    if (curEntry) {
      const prevEntry = newestSessionEntryOnOrBefore(
        sessions,
        "vo2max",
        curEntry.date
      );
      if (prevEntry)
        priorHeadlineFitnessAge = fitnessAge(
          vo2Def.normsMarker,
          prevEntry.value,
          sex,
          age
        );
    }
  }

  return {
    latestDate: latestSession?.date ?? null,
    priorDate: priorSessionDate,
    measuredCount,
    totalCount: battery.length,
    coverage: coverageOf(results),
    results,
    domains,
    // Headline fitness age stays VO2-only — a rough self-norm band never moves it (#1135).
    headlineFitnessAge: vo2?.fitnessAge ?? null,
    priorHeadlineFitnessAge,
  };
}
