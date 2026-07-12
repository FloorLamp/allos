// The shared "findings bus" envelope (issue #39, phases 1–3). Pure, no DB/network.
//
// Three rule engines emit their own near-parallel output today: the seven
// forward-looking due-signals as `UpcomingItem` (lib/upcoming.ts), the rule-based
// coaching engine as `Recommendation` (lib/coaching.ts), and the "what's trending"
// digest as `TrendItem` (lib/trends-digest.ts). They render on different surfaces
// but share the same needs — a title/detail, an optional action, a stable identity
// for snooze/dismiss, and (for the dated ones) urgency banding. `Finding` is the
// superset envelope those three reconcile to, so a single suppression layer can
// silence ANY of them by one key.
//
// Design tradeoffs:
//   - Envelope, not replacement. The three engines keep their own richer shapes
//     (an UpcomingItem still carries doseId; a Recommendation still carries a
//     next-set `target`); Finding is what they map INTO at the boundary via the
//     thin adapters below. That's the least-invasive change — no engine rewrite,
//     no consumer churn beyond the surfaces that opt into suppression.
//   - `dedupeKey` is the single identity. It IS the value stored in the
//     upcoming_dismissals table's `signal_key` column, so existing Upcoming keys
//     ("dose:12", "biomarker:ldl", …) keep matching unchanged; coaching/digest
//     just contribute new domain-prefixed keys into the same store.
//   - Banding fields are OPTIONAL. Only date/status-driven findings (Upcoming) set
//     dueDate/band/dueText; coaching and digest findings omit them. The banding
//     helpers below generalize groupUpcoming so any Finding with a due date can be
//     bucketed, while lib/upcoming.ts keeps its own (identical) banding for the
//     Upcoming page — the two share the band primitives, so there's one source of
//     truth for the band boundaries.

import {
  type UrgencyBand,
  type UpcomingItem,
  BAND_ORDER,
  BAND_LABELS,
  daysUntilDue,
  bandForDays,
} from "./upcoming";
import type { CoachingTone, Recommendation, PR, CardioPR } from "./coaching";
import type { TrendItem } from "./trends-digest";
import type { WeightUnit, DistanceUnit } from "./settings";
import { fmtWeight, fmtDistance, fmtKmh } from "./units";
import { formatMinutes } from "./duration";
import { isSuppressed, type SuppressionRecord } from "./upcoming-suppress";

// Visual/semantic tone, doubling as a coarse severity signal. A superset of
// CoachingTone (caution/action/positive/neutral) plus a plain informational tone
// for findings that are neither good nor bad (a neutral metric move).
export type FindingTone = CoachingTone | "info";

export interface Finding {
  // Origin namespace — an Upcoming domain ("dose"/"biomarker"/…), "coaching", or
  // "digest". Drives iconography/grouping, not identity.
  domain: string;
  // Stable identity for suppression + React keys. Domain-prefixed and collision-
  // free across engines; this is exactly the string stored as a suppression row's
  // signal_key (e.g. "dose:12", "coaching:rest-sleep", "digest:bio:LDL:up").
  dedupeKey: string;
  // A LEGACY (pre-#436, episode-less) dedupeKey this finding ALSO honors for
  // suppression. The behavioral engines grew an episode anchor on their keys (#436)
  // so a dismissal is "this episode" not "this topic forever"; `supersedes` carries
  // the old key shape so a dismissal stored under it keeps suppressing the current
  // finding (dual-read) rather than orphaning. Fresh dismissals are always written
  // against `dedupeKey` (episodic). Consulted by activeFindings below. Note the
  // documented dual-read limitation: a pre-#436 dismissal remains sticky across
  // future distinct episodes (it lacks the anchor to tell them apart); every
  // NEW dismissal is per-episode.
  supersedes?: string;
  title: string;
  detail?: string | null;
  tone?: FindingTone;
  // Optional supporting evidence (the number/hint behind the finding) for surfaces
  // that show a rationale line; opaque to the envelope.
  evidence?: string | null;
  actionHref?: string;
  actionLabel?: string;
  // ---- Banding (Upcoming only) ----
  // Due date as YYYY-MM-DD; null / omitted = due now / no calendar date.
  dueDate?: string | null;
  // Explicit band override for status-driven findings without a numeric date.
  band?: UrgencyBand;
  // Explicit due-text override; else a computed countdown label.
  dueText?: string;
}

export interface FindingGroup {
  band: UrgencyBand;
  label: string;
  items: Finding[];
}

// The band a finding belongs to: an explicit `band` override wins (status-driven),
// else it's derived from the due date relative to today. Generalized from
// bandForItem so it bands any Finding, not just an UpcomingItem.
export function bandForFinding(f: Finding, today: string): UrgencyBand {
  return f.band ?? bandForDays(daysUntilDue(f.dueDate ?? null, today));
}

// The effective calendar date used to sort a finding within its band; a null due
// date sorts as today so status-driven findings cluster with same-day work.
function sortDate(f: Finding, today: string): string {
  return f.dueDate ?? today;
}

// Bucket findings into the four urgency bands, each sorted by effective due date
// ascending, then domain, then dedupeKey — deterministic. Empty bands dropped;
// non-empty bands returned in fixed Overdue → Today → This week → Later order.
// The generic form of groupUpcoming (lib/upcoming.ts), for any Finding with a due
// date; the two share the band primitives so the boundaries never drift.
export function groupFindings(
  findings: Finding[],
  today: string
): FindingGroup[] {
  const byBand = new Map<UrgencyBand, Finding[]>();
  for (const f of findings) {
    const band = bandForFinding(f, today);
    const arr = byBand.get(band);
    if (arr) arr.push(f);
    else byBand.set(band, [f]);
  }
  const groups: FindingGroup[] = [];
  for (const band of BAND_ORDER) {
    const arr = byBand.get(band);
    if (!arr || arr.length === 0) continue;
    arr.sort(
      (a, b) =>
        sortDate(a, today).localeCompare(sortDate(b, today)) ||
        a.domain.localeCompare(b.domain) ||
        a.dedupeKey.localeCompare(b.dedupeKey)
    );
    groups.push({ band, label: BAND_LABELS[band], items: arr });
  }
  return groups;
}

// ---- Dedupe-key builders (one format, shared by adapters + the filter side) ----

// A coaching recommendation's suppression key. Prefixed so it never collides with
// an Upcoming domain key.
export function coachingDedupeKey(id: string): string {
  return `coaching:${id}`;
}

// A digest chip's suppression key: the series key plus its direction, so a
// dismissed chip stays dismissed only while the SAME-direction trend persists — a
// reversal produces a new key and resurfaces the chip.
export function digestDedupeKey(
  item: Pick<TrendItem, "key" | "direction">
): string {
  return `digest:${item.key}:${item.direction}`;
}

// ---- Adapters (thin mappings, not rewrites) ----

// UpcomingItem → Finding. UpcomingItem already carries the banding fields and a
// stable `key`; this is a plain rename (key → dedupeKey, href → actionHref) so an
// UpcomingItem flows through the findings bus and shared suppression unchanged.
export function upcomingToFinding(item: UpcomingItem): Finding {
  return {
    domain: item.domain,
    dedupeKey: item.key,
    title: item.title,
    detail: item.detail ?? null,
    actionHref: item.href,
    dueDate: item.dueDate,
    band: item.band,
    dueText: item.dueText,
  };
}

// Coaching Recommendation → Finding. The next-set `target` (when present) becomes
// the finding's evidence line.
export function recommendationToFinding(rec: Recommendation): Finding {
  return {
    domain: "coaching",
    dedupeKey: coachingDedupeKey(rec.id),
    title: rec.title,
    detail: rec.detail,
    tone: rec.tone,
    actionHref: rec.actionHref,
    actionLabel: rec.actionLabel,
    evidence: rec.target ?? null,
  };
}

// Digest TrendItem → Finding. Tone reflects the clinical range crossing (an out-of-
// range move is caution, a return into range is positive); a plain move is neutral.
export function trendItemToFinding(item: TrendItem): Finding {
  return {
    domain: "digest",
    dedupeKey: digestDedupeKey(item),
    title: item.label,
    detail: item.text,
    tone:
      item.rangeShift === "out-of-range"
        ? "caution"
        : item.rangeShift === "into-range"
          ? "positive"
          : "neutral",
  };
}

// Strength PR (lib/coaching) → Finding. A celebratory ("positive") finding whose
// detail is a self-contained clause ("Back Squat at 120 kg × 5") so a narrator can
// splice it straight into a sentence. The load is rendered in the reader's weight
// unit here (the envelope stays display-formatted, like TrendItem.text). dedupeKey
// is domain-prefixed by exercise + record kind, and dueDate carries the PR's date.
export function prToFinding(pr: PR, weightUnit: WeightUnit): Finding {
  const clause =
    pr.kind === "weight"
      ? `${pr.exercise} top set at ${fmtWeight(pr.weightKg, weightUnit)}`
      : pr.bodyweight
        ? `${pr.exercise} at bodyweight × ${pr.reps}`
        : `${pr.exercise} at ${fmtWeight(pr.weightKg, weightUnit)} × ${pr.reps}`;
  return {
    domain: "pr",
    dedupeKey: `pr:strength:${pr.exercise}:${pr.kind}`,
    title: pr.exercise,
    detail: clause,
    tone: "positive",
    dueDate: pr.date,
  };
}

// Cardio PR (lib/coaching) → Finding. As prToFinding, but the clause names the
// record dimension (longest/fastest/longest-duration) and renders distance/speed
// in the reader's distance unit; the duration record uses formatMinutes.
export function cardioPrToFinding(
  pr: CardioPR,
  distanceUnit: DistanceUnit
): Finding {
  const clause =
    pr.kind === "distance"
      ? `longest ${pr.activity} at ${fmtDistance(pr.distanceKm, distanceUnit)}`
      : pr.kind === "speed"
        ? `fastest ${pr.activity} at ${fmtKmh(pr.speedKmh, distanceUnit)}`
        : `longest ${pr.activity} at ${formatMinutes(pr.durationMin)}`;
  return {
    domain: "pr",
    dedupeKey: `pr:cardio:${pr.activity}:${pr.kind}`,
    title: pr.activity,
    detail: clause,
    tone: "positive",
    dueDate: pr.date,
  };
}

// ---- Shared suppression filter ----

// Keep only the items NOT currently suppressed by the profile's snooze/dismiss
// `map` (dedupeKey → record). Generic over the item type via a key accessor, so a
// caller filters its OWN engine's output (Recommendation[], TrendItem[], …) without
// first converting to Finding[]. Reuses the pure isSuppressed decision, so an
// expired snooze reveals its item exactly as on the Upcoming page.
export function activeByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
  map: Map<string, SuppressionRecord>,
  today: string
): T[] {
  return items.filter((item) => {
    const rec = map.get(keyOf(item));
    return !(rec && isSuppressed(rec, today));
  });
}

// Whether a Finding is suppressed right now, honoring BOTH its `dedupeKey` and its
// optional legacy `supersedes` key (dual-read, #436): a dismissal stored under either
// hides it. The two-key check is why the episode-anchored engines can change their key
// shape without orphaning a dismissal made under the old shape.
export function isFindingSuppressed(
  finding: Pick<Finding, "dedupeKey" | "supersedes">,
  map: Map<string, SuppressionRecord>,
  today: string
): boolean {
  const keys = finding.supersedes
    ? [finding.dedupeKey, finding.supersedes]
    : [finding.dedupeKey];
  for (const key of keys) {
    const rec = map.get(key);
    if (rec && isSuppressed(rec, today)) return true;
  }
  return false;
}

// The Finding-typed twin of activeByKey that also consults `supersedes` — the filter
// the page surfaces for the episode-anchored behavioral engines use so a legacy
// dismissal keeps suppressing the current finding (#436). Preserves order; drops any
// finding hidden by a dismiss/snooze on its episodic OR legacy key.
export function activeFindings(
  findings: Finding[],
  map: Map<string, SuppressionRecord>,
  today: string
): Finding[] {
  return findings.filter((f) => !isFindingSuppressed(f, map, today));
}
