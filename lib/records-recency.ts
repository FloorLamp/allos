// RECORDS-RECENCY REQUESTS — the pure decision behind #2164 and #2176.
//
// ── One shape, three legs ────────────────────────────────────────────────────
//
// Some of what allos knows arrives through a channel only a PERSON can operate. A
// portal run needs somebody at the machine with the login (#1757). A Fitbit Takeout
// archive needs somebody to ask Google for an export and hand it over (#2164). A paper
// result or a PDF from the clinic needs somebody to photograph it (#2176). Nothing
// about those channels can be scheduled, retried, or repaired by the app, so when they
// go quiet the only available move is to ASK.
//
// #1757 shipped the first leg with a real table, because a portal request has causes
// the data cannot express: a person pressing "Request sync", a visit that just
// happened. This module is the generalization the other two legs asked for (#2176
// constraint 1), and the generalization is deliberately NOT "make the other two write
// rows into portal_sync_requests". It is the shared question underneath:
//
//   > A person-operated SOURCE delivers a stream of dated data. How far behind is the
//   > newest thing it delivered, and is that far enough to be worth asking about?
//
// Everything else — the table, the reasons, the salience ladder, the TTL — belongs to
// #1757's causes, not to this question. A leg whose ask is a pure function of the data
// needs no row at all: openness is derived (the #1757 property, kept), and here the
// derivation has no stored input either. See "Why no table" below.
//
// ── The clock reads the DATA, never the event ────────────────────────────────
//
// THE load-bearing rule, and the same rule in both legs:
//
//   #2164 — the FRONTIER is the newest archive-sourced DATA date, not the import
//   event's timestamp. Importing a six-month-old archive today advances nothing, so
//   it does not silence the ask; that is the whole difference between "you did an
//   import" and "you are caught up".
//
//   #2176 — the FRONTIER is the newest COLLECTION date, not the upload date (the
//   #557/#283 discipline). A backfill of a decade of old results uploaded this
//   afternoon must not reset the clock, and a result collected last month that only
//   gets photographed today must clear it.
//
// Both fall out of one sentence: the frontier is a fact about the DATA. This module
// never sees an event timestamp, and the query layer that feeds it reads a `date`
// column, never a `created_at` / `uploaded_at` / sync-event column.
//
// ── Why no table, and what the episode key buys ──────────────────────────────
//
// #1757 stores a row because a manual "Request sync" tap and a post-visit trigger are
// events with no trace in the data. Both legs here are pure staleness: the frontier
// and today are enough, so a row would only be a cache that can disagree with the
// facts. The one thing #1757's row supplied that a derived ask still needs is a STABLE
// IDENTITY for the dismissal bus, and the frontier supplies it:
//
//   `records-recency:<source>:<frontier>`
//
// A dismissal means "not this ask". The frontier moves only when the source actually
// delivered something newer — which is exactly the event that ends the episode — so a
// dismissed ask stays dismissed for as long as the situation is unchanged, and the
// next staleness episode after a real refresh is a NEW key that surfaces again. A
// backfill of older records leaves `MAX(date)` alone, so it neither answers the ask
// nor resurrects a dismissed one.
//
// The honest edge: a refresh that advances the frontier WITHOUT clearing the ask (an
// archive that was already three weeks old when it was downloaded) mints a new key and
// re-raises a dismissed row. That is deliberate. The person acted, the data moved, and
// the ask now says something different — "still 21 days behind" is new information,
// not a repeat of the sentence they dismissed.
//
// ── Reach: rows only, coaching tier, never a send ────────────────────────────
//
// Both legs travel exactly #1757's reach and no further: an Upcoming item, the digest
// line that page's own banding yields, and nothing else. No `notify_*` marker, no
// dedicated channel, no escalation, and excluded from the non-hideable "Needs
// attention" hero (`CARD_EXCLUDED_DOMAINS`, lib/attention.ts) — records hygiene is
// never a safety signal, and an ask that cannot be dismissed is a nag.

import { freshnessAgeDays, freshnessState } from "./freshness";
import { preventiveRuleByKey } from "./preventive-catalog";

// ── Vocabulary ───────────────────────────────────────────────────────────────

// The suppression-bus namespace (registered in lib/rule-finding-prefixes.ts).
export const RECORDS_RECENCY_PREFIX = "records-recency:";

// The person-operated sources that can carry a recency ask. A CLOSED union: the key
// is `records-recency:<source>:<frontier>`, so a source id is part of a persisted
// dismissal row and must not be renamed once shipped.
//
// `archive:<source>` rather than a bare source id, so the archive leg reads as one
// family however many `kind: "archive"` sources the registry grows.
export const RECORDS_RECENCY_SOURCES = [
  // #2164 — the Fitbit (Google Takeout) archive's exclusive streams.
  "archive:fitbit-takeout",
  // #2176 — the profile's lab/biomarker frontier, for a household with no portal.
  "clinical-records",
] as const;

export type RecordsRecencySource = (typeof RECORDS_RECENCY_SOURCES)[number];

/** `archive:<source>` for a `kind: "archive"` source's refresh ask. */
export function archiveRecencySource(sourceId: string): string {
  return `archive:${sourceId}`;
}

// ── The decision ─────────────────────────────────────────────────────────────

/** What one source presents to the decision. Facts only — no ids, no copy. */
export interface RecordsRecencySignals {
  /**
   * The newest DATA date this source has delivered, `YYYY-MM-DD`, or null when it has
   * delivered nothing at all. NEVER an import / upload / sync-event stamp.
   */
  frontier: string | null;
  /** The profile-local day the question is being asked on. */
  today: string;
  /** The declared horizon, in whole days. Stale STRICTLY after it. */
  horizonDays: number;
  /**
   * ONE ASK PER PROBLEM. True when another mechanism already owns this profile's
   * ask for this data — #2176's case: a profile with a mapped patient portal is
   * #1757's to nag, and two asks about one gap are noise, not reach.
   */
  ownedElsewhere: boolean;
}

export type RecordsRecencySkip =
  /** Another mechanism owns the ask (#1757's portal request). */
  | "owned-elsewhere"
  /**
   * The source never delivered anything, so there is no frontier to age. This is the
   * #2176 constraint-4 carve-out and the #2164 "a profile that has never imported an
   * archive is exempt by construction" case, in ONE guard: a profile with no clinical
   * base at all belongs to onboarding (#2173), not to staleness.
   */
  | "no-frontier"
  /** Within the horizon — nothing to ask about. */
  | "current";

export type RecordsRecencyVerdict =
  | { due: false; skip: RecordsRecencySkip }
  | { due: true; frontier: string; daysBehind: number };

/**
 * Is a recency ask due for this source?
 *
 * The guard ORDER is part of the contract: yield to the mechanism that owns the ask,
 * then check there was ever anything to age, and only then read the clock. Deciding
 * staleness first and exempting afterwards would let a portal profile's frontier
 * choose the key of an ask that is never raised.
 *
 * The clock itself is `lib/freshness.ts` — the house's one staleness decision, stale
 * STRICTLY after the interval, not a fourth re-derivation of `age > horizon`.
 */
export function recordsRecencyVerdict(
  s: RecordsRecencySignals
): RecordsRecencyVerdict {
  if (s.ownedElsewhere) return { due: false, skip: "owned-elsewhere" };
  if (!s.frontier) return { due: false, skip: "no-frontier" };
  const age = freshnessAgeDays(s.frontier, s.today);
  if (age == null) return { due: false, skip: "no-frontier" };
  if (freshnessState(age, s.horizonDays) !== "due")
    return { due: false, skip: "current" };
  return { due: true, frontier: s.frontier, daysBehind: age };
}

// ── The clinical horizon, read from the preventive catalog ───────────────────
//
// #2176 constraint 3: the horizon is a DECLARED default, and a profile whose preventive
// schedule implies a different rhythm reads that schedule rather than the adult default
// — reusing, never forking, the preventive engine's age banding.
//
// So the number is not written here. It is read off the catalog's ROUTINE CHECK-UP
// rules, which already carry the age bands and the cadence: `wellchild_annual` covers
// ages 3–21 and `adult_physical` takes over at 22, both on a 12-month interval with a
// 3-month grace. If the catalog's cadence ever bands differently by age, this horizon
// follows it without an edit here.
//
// INTERVAL **PLUS GRACE**, which is the nesting that keeps this from double-asking. The
// preventive engine already says "you are due for a check-up" at the interval; this ask
// is the RECORDS consequence of that check-up not having happened, so it must sit
// strictly behind the engine that owns the appointment. The rule's own declared grace is
// exactly that lag, and using it means the two numbers cannot drift apart.
//
// Below the well-child annual's start age the catalog's schedule is a MILESTONE ladder
// with no interval to read, so an under-3 profile takes the default. That is the honest
// answer rather than a derived one: milestone visits are 1–3 months apart, and a
// two-month lab-recency horizon for an infant would ask about a frontier most infants
// do not have at all (and the `no-frontier` guard already exempts them).

// The catalog rules that model "a routine check-up at which new results are produced".
// A named set, so a future recurring visit rule (dental, vision) cannot drift into the
// horizon by accident — those visits do not produce lab work.
export const CHECKUP_RULE_KEYS: readonly string[] = [
  "wellchild_annual",
  "adult_physical",
];

// The fallback when no check-up rule covers the profile's age — an unknown age, or one
// below the well-child annual's start. Twelve months plus the catalog's own three-month
// grace, i.e. the same arithmetic the resolved path performs.
export const DEFAULT_CLINICAL_RECENCY_MONTHS = 15;

// Mean Gregorian month, so "15 months" is a whole number of days once and identically
// everywhere. The horizon is coarse by nature; this only stops it wobbling by a day
// depending on which months it spans.
const DAYS_PER_MONTH = 30.4375;

/**
 * The lab/biomarker recency horizon in whole days for a profile of this age (in
 * months; null = unknown).
 */
export function clinicalRecencyHorizonDays(
  ageMonths: number | null | undefined
): number {
  return Math.round(clinicalRecencyHorizonMonths(ageMonths) * DAYS_PER_MONTH);
}

/** The same horizon in months — exported for the tests and the docs to name. */
export function clinicalRecencyHorizonMonths(
  ageMonths: number | null | undefined
): number {
  if (ageMonths == null || !Number.isFinite(ageMonths))
    return DEFAULT_CLINICAL_RECENCY_MONTHS;
  for (const key of CHECKUP_RULE_KEYS) {
    const rule = preventiveRuleByKey(key);
    if (!rule || rule.schedule.type !== "recurring") continue;
    const { startMonths, endMonths, intervalMonths } = rule.schedule;
    if (ageMonths < startMonths) continue;
    if (endMonths != null && ageMonths >= endMonths) continue;
    return intervalMonths + rule.graceMonths;
  }
  return DEFAULT_CLINICAL_RECENCY_MONTHS;
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * The ONE dedupe key every surface uses — the Upcoming item, the digest line and the
 * dismissal row are one identity, so a dismiss on either surface silences both
 * (#221).
 *
 * ANCHORED ON THE FRONTIER, which is what makes "not this ask" mean the episode
 * rather than the source forever. See the module header for the full argument and its
 * one deliberate edge.
 */
export function recordsRecencyDedupeKey(
  source: string,
  frontier: string
): string {
  return `${recordsRecencyFamily(source)}:${frontier}`;
}

/**
 * The TOPIC the key above is an episode of — "records from THIS source are behind" —
 * declared for the repeat-dismissal family lookup (#2543/#2386). Minted by the key
 * itself from the same component, so the stem cannot drift wider than the identity it
 * belongs to.
 *
 * The stem is the SOURCE and never the namespace: an archive export nobody downloads and
 * a lab result nobody photographs are two different errands, and folding them into one
 * family would let declines of the easy one quiet the ask about the other. That is the
 * over-broad-stem failure mode this mechanism invites, refused here at the declaration.
 *
 * Counting under this stem counts genuinely SEPARATE staleness episodes, because the
 * frontier only moves when the source actually delivered something newer. A user who
 * never uploads keeps ONE key and never accumulates — which is right: that is one ask
 * still standing, not a pattern of declining.
 */
export function recordsRecencyFamily(source: string): string {
  return `${RECORDS_RECENCY_PREFIX}${source}`;
}

// ── Copy ─────────────────────────────────────────────────────────────────────
//
// ONE formatter per leg, and both obey the same two rules the issues state:
//
//   THE COPY STATES THE DATA, NOT THE PERSON (#2164 constraint 5, #2176 constraint 5).
//   "Weight is 41 days behind", never "you haven't imported in a while".
//
//   IT NAMES THE ACTION A PERSON TAKES, like #1757's does, because the entire premise
//   is that a machine cannot do this one and a person must.
//
// The frontier is quoted as its RAW ISO date, the way `biomarkerRetestDetail` quotes a
// last-tested date on the same page. These strings are built by an Upcoming generator,
// which renders both to a login (the page) and to a login-less channel (the digest), so
// there are no DisplayFormatPrefs in scope to thread — and an unambiguous ISO date is
// the honest answer rather than silently imposing one login's date shape on the other
// channel (the #964/#1448 rule, and lib/__tests__/date-locale-guard.test.ts enforces it).

/** "41 days" / "6 weeks" / "15 months" — a coarse, honest interval. */
export function recencyIntervalPhrase(days: number): string {
  if (days >= 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  if (days >= 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** "weight, body fat and sleep score" — an Oxford-less English list. */
export function joinStreamLabels(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export interface RecordsRecencyCopy {
  title: string;
  detail: string;
  /**
   * The short CAUSE FRAGMENT the digest's named line concatenates after the title
   * (#1913 item 6). `detail` is written for a CARD — a complete sentence that may
   * restate the subject — so the digest needs its own, subject-less form.
   */
  because: string;
}

/** The archive refresh ask (#2164). */
export function archiveRefreshCopy(input: {
  sourceName: string;
  /** The exclusive streams that have actually delivered something, lowercase. */
  streamLabels: readonly string[];
  frontier: string;
  daysBehind: number;
}): RecordsRecencyCopy {
  const streams = joinStreamLabels(input.streamLabels);
  const behind = recencyIntervalPhrase(input.daysBehind);
  return {
    title: `Import a fresh ${input.sourceName} export`,
    detail:
      `${streams} reach allos only through a ${input.sourceName} export. ` +
      `The last one carried data through ${input.frontier} — ${behind} behind. ` +
      `Download a fresh archive and import it to catch up.`,
    because: `${streams} ${input.streamLabels.length === 1 ? "is" : "are"} ${behind} behind`,
  };
}

/** The manual-upload records ask (#2176). */
export function clinicalRecencyCopy(input: {
  frontier: string;
  daysBehind: number;
}): RecordsRecencyCopy {
  const when = input.frontier;
  return {
    title: "Bring lab results up to date",
    detail:
      `The newest lab result on file is from ${when} — ${recencyIntervalPhrase(input.daysBehind)} ago. ` +
      `Upload recent results, or connect a patient portal, to keep biomarker trends and the Longevity pillar current.`,
    because: `the newest lab result is from ${when}`,
  };
}
