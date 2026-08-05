// THE dismissal-key classification registry (issue #1931).
//
// Every row in `upcoming_dismissals` is a promise to a person: "you have told me to
// stop showing you THIS, and I will keep quiet." The whole risk of the store is that a
// key stops pointing at the thing the person silenced. `signal_key` is an arbitrary
// string, and the tail of a key is sometimes an AUTOINCREMENT id (which never
// recycles, #203), sometimes a fixed catalog token, sometimes a date, and sometimes a
// USER-TYPED NAME — an exercise, an activity, a biomarker — which absolutely does
// recycle (AGENTS.md row-ops: "names and codes DO recycle"). When the last of those is
// left unswept, deleting the subject and later reusing its name hands a brand-new
// signal a dismissal it never earned: silence that nobody asked for.
//
// That failure has now been found and fixed one namespace at a time — #203/#283/#327
// for the biomarker keys, #376 for the immunization codes, #1399/#1610 for the
// training-observation keys, #1931 for the personal-record keys. Each time, the audit
// had to be re-derived by hand across ~70 prefixes. This registry ends that: EVERY
// dismissal namespace declares which of the classes below it belongs to, and a
// name-keyed one must NAME the sweep that de-orphans it.
//
// THE TEETH (lib/__tests__/dismissal-classes.test.ts):
//   1. The registry and `SUPPRESSION_DISPLAY_PREFIXES` are the same set. The display
//      table is the enumeration of every namespace the bus can render, so a prefix
//      that is displayable but unclassified — or classified but undisplayable — fails.
//   2. A source scan over every `export const *_PREFIX = "…"` in lib/ requires each
//      literal to be either a classified dismissal namespace or listed in
//      NON_DISMISSAL_PREFIXES with a stated reason. A new signal-key prefix therefore
//      cannot reach main without someone deciding, in writing, whether it recycles.
//   3. `name-keyed-swept` requires a non-empty `sweep`; `name-keyed-open` and `legacy`
//      require a non-empty `risk`. A class cannot be claimed without its evidence.
//
// The registry is DATA and the enforcement is a reflection/scan test — the same shape
// as STATEFUL_WRITE_TABLES, CROSS_PROFILE_SQL_MODULES and RULE_FINDING_REGISTRY. It is
// pure (string constants only), so it stays importable from any tier.
//
// WHAT THIS DOES NOT CATCH, stated so the next audit doesn't over-trust it: a key
// namespace that is BOTH spelled inline (no `*_PREFIX` export) AND missing from the
// display resolver escapes both teeth. That combination already means the key renders
// as an unnameable orphan row in Upcoming's "Snoozed & dismissed", which is its own
// visible defect — the #1931 sweep found `steps-pace:` exactly that way and added it.

import { SUPPRESSION_DISPLAY_PREFIXES } from "./suppression-display";

/**
 * How a dismissal key is protected from re-attaching to a subject the user never
 * silenced. The four safe classes are four different mechanisms, not four flavours of
 * the same one; the two unsafe classes exist so residual risk is written down rather
 * than rediscovered.
 */
export type DismissalKeyClass =
  /** The tail is an AUTOINCREMENT row id. Ids never recycle (#203), so a dead row's
   *  dismissal is inert forever — it lingers by design and stays restorable. */
  | "id-keyed"
  /** The tail is a fixed vocabulary token: a catalog code, an enum member, a curated
   *  rule key, a derived clinical identity. The SUBJECT is the topic itself, so a
   *  dismissal legitimately means "stop telling me about this topic" and outliving any
   *  particular row is the intended behavior, not a bug. */
  | "catalog"
  /** The tail carries a DATE, period or episode anchor, so a new occurrence mints a
   *  new key. A dormant row can only re-attach to a recurrence of the same anchor. */
  | "anchored"
  /** The tail contains a user-recyclable name AND a named sweep drops the row when its
   *  backing data leaves. `sweep` must name that function. */
  | "name-keyed-swept"
  /** The tail contains a user-recyclable name and NOTHING sweeps it. `risk` must state
   *  the residual exposure. Declaring this is a deliberate, reviewable act. */
  | "name-keyed-open"
  /** A key shape no write path mints anymore. Bounded residue from already-stored
   *  rows; `risk` must say what that residue is. */
  | "legacy";

export interface DismissalKeyEntry {
  /** The `signal_key` namespace, including its trailing separator. */
  prefix: string;
  keyClass: DismissalKeyClass;
  /** The key's tail shape, so a reader can check the class without chasing the
   *  builder — e.g. "`<movementLoadKey>:<kind>`". */
  shape: string;
  /** For `name-keyed-swept`: the function that de-orphans this namespace. */
  sweep?: string;
  /** For `name-keyed-open` / `legacy`: the residual exposure, stated plainly. */
  risk?: string;
}

// The single source of truth. One entry per namespace the suppression bus can carry.
export const DISMISSAL_KEY_REGISTRY: readonly DismissalKeyEntry[] = [
  // ---- id-keyed: the tail is a row id (#203 — ids never recycle) -------------
  {
    prefix: "dose:",
    keyClass: "id-keyed",
    shape: "`<doseId>`",
  },
  {
    prefix: "refill:",
    keyClass: "id-keyed",
    shape: "`<intakeItemId>`",
  },
  {
    prefix: "available:",
    keyClass: "id-keyed",
    shape: "`<intakeItemId>` (a declined `may` offer, #1505)",
  },
  {
    prefix: "pool-refill:",
    keyClass: "id-keyed",
    shape: "`<sharedSupplyId>`",
  },
  {
    prefix: "appointment:",
    keyClass: "id-keyed",
    shape: "`<appointmentId>`",
  },
  {
    prefix: "careplan:",
    keyClass: "id-keyed",
    shape: "`<carePlanItemId>`",
  },
  { prefix: "goal:", keyClass: "id-keyed", shape: "`<goalId>`" },
  {
    prefix: "training:",
    keyClass: "id-keyed",
    shape: "`<frequencyTargetId>`",
  },
  {
    prefix: "practice:",
    keyClass: "id-keyed",
    shape: "`<frequencyTargetId>`",
  },
  {
    prefix: "endurance-event:",
    keyClass: "id-keyed",
    shape: "`<endurancePlanId>`",
  },
  {
    prefix: "med-monitor:",
    keyClass: "id-keyed",
    shape: "`<medId>:<curatedEntryKey>`",
  },
  { prefix: "prn-max:", keyClass: "id-keyed", shape: "`<intakeItemId>`" },
  {
    prefix: "interaction:",
    keyClass: "id-keyed",
    shape: "`<loItemId>-<hiItemId>`",
  },
  {
    prefix: "pgx:",
    keyClass: "id-keyed",
    shape: "`<medId>:<geneNorm>:<status>`",
  },
  {
    prefix: "allergy-med:",
    keyClass: "id-keyed",
    shape: "`<allergyId>-<intakeItemId>`",
  },
  {
    prefix: "contrast:",
    keyClass: "id-keyed",
    shape: "`<source>:<sourceId>:<gate>:<contrastClass>`",
  },
  {
    prefix: "dental-safety:",
    keyClass: "id-keyed",
    shape: "`<procedureId>:<gateKey>`",
  },
  {
    prefix: "ototoxic:",
    keyClass: "id-keyed",
    shape: "`<medId>:<curatedEntryKey>`",
  },
  {
    prefix: "keep-apart:",
    keyClass: "id-keyed",
    shape: "`<loItemId>-<hiItemId>`",
  },
  {
    prefix: "food-timing:",
    keyClass: "id-keyed",
    shape: "`<intakeItemId>:<curatedRuleId>`",
  },
  {
    prefix: "food-drug-event:",
    keyClass: "id-keyed",
    shape: "`<intakeItemId>:<curatedRuleId>:<YYYY-MM-DD>` (#2021)",
  },
  {
    prefix: "food-drug-variance:",
    keyClass: "id-keyed",
    shape: "`<intakeItemId>:<curatedRuleId>` (#2021)",
  },
  {
    prefix: "followup:",
    keyClass: "id-keyed",
    shape: "`<carePlanItemId>`",
  },
  {
    prefix: "surgery-bridge:",
    keyClass: "id-keyed",
    shape: "`<phase>:<visitId>`",
  },
  {
    prefix: "dormant-prn:",
    keyClass: "id-keyed",
    shape: "`<intakeItemId>`",
  },
  {
    prefix: "body-hygiene:",
    keyClass: "id-keyed",
    shape: "`weight-jump:<bodyMetricId>`",
  },
  {
    prefix: "goal-pace:",
    keyClass: "id-keyed",
    shape: "`goal:<goalId>`, plus the fixed `weight-loss-rate` topic key",
  },
  {
    prefix: "demote-obligation:",
    keyClass: "id-keyed",
    shape:
      "`<intakeItemId>:<periodAnchor>` (legacy dual-read: `<intakeItemId>`)",
  },
  {
    prefix: "right-size:",
    keyClass: "id-keyed",
    shape:
      "`<frequencyTargetId>:<periodAnchor>` (legacy dual-read: `<frequencyTargetId>`)",
  },
  {
    prefix: "adherence:",
    keyClass: "id-keyed",
    shape: "`weekday:<doseId>:<weekday>` / `weekend:<doseId>`",
  },
  {
    prefix: "weather-med:",
    keyClass: "id-keyed",
    shape: "`<exposure>:<intakeItemId>:<curatedEntryKey>:<date>`",
  },

  // ---- catalog: a fixed vocabulary; the topic IS the subject -----------------
  {
    prefix: "screening:",
    keyClass: "catalog",
    shape: "`<preventiveRuleKey>` (lib/preventive-catalog)",
    // Not a sweep in the orphan sense — a rule key can't recycle — but the episode-end
    // retire (clearPreventiveDismissal, #1024) keeps a dismissal from silencing the
    // NEXT due cycle. Recorded here so the two mechanisms aren't confused.
  },
  {
    prefix: "visit:",
    keyClass: "catalog",
    shape: "`<preventiveRuleKey>` (lib/preventive-catalog)",
  },
  {
    prefix: "dietary-limit:",
    keyClass: "catalog",
    shape: "`<nutrientKey>` (lib/dri)",
  },
  {
    prefix: "rda-adequacy:",
    keyClass: "catalog",
    shape: "`<nutrientKey>` (lib/dri)",
  },
  {
    prefix: "food-suggest:",
    keyClass: "catalog",
    shape: "`<nutrientKey>`",
  },
  {
    prefix: "food-reduce:",
    keyClass: "catalog",
    shape: "`<reduceKey>`",
  },
  {
    prefix: "food-habit:",
    keyClass: "catalog",
    shape: "`<foodGroupSlug>`",
  },
  {
    prefix: "protein-adequacy:",
    keyClass: "catalog",
    shape: "the fixed `shortfall` topic key",
  },
  {
    prefix: "fiber-adequacy:",
    keyClass: "catalog",
    shape: "the fixed `shortfall` topic key",
  },
  {
    prefix: "oral-health:",
    keyClass: "catalog",
    shape: "the fixed `periodontal:diabetes` topic key",
  },
  {
    prefix: "substance-use:",
    keyClass: "catalog",
    shape: "`over-target:<substance>` (the Substance enum)",
  },
  {
    prefix: "endurance:",
    keyClass: "catalog",
    shape: "`long-session:<discipline>` (the discipline enum)",
  },
  {
    prefix: "mobility-suggest:",
    keyClass: "catalog",
    shape: "`<source>:<mobilityRegion>` (both curated vocabularies)",
  },
  {
    prefix: "data-quality:",
    keyClass: "catalog",
    shape: "`<gapType>` (the closed set of structural gaps)",
  },
  {
    prefix: "condition-review:",
    keyClass: "catalog",
    shape: "`<conditionCollapseKey>` (code-first clinical concept identity)",
  },
  {
    prefix: "condition-consideration:",
    keyClass: "catalog",
    shape: "`<curatedEntryKey>`",
  },
  {
    prefix: "med-dup:",
    keyClass: "catalog",
    shape: "`<ingredientFamilyKey>` (RxNorm ingredient CUI where one exists)",
    // The documented fallback when NO member carries a code is `medNameKey`, i.e. a
    // derived name. lib/medication-family.ts states the posture: a member rename
    // re-keys the family, the old dismissal goes INERT and the note resurfaces once —
    // the safe direction for a safety-adjacent note, and the opposite of the #1931
    // hazard (which was a stale key silencing something new).
  },
  {
    prefix: "coaching:",
    keyClass: "catalog",
    shape: "`<recommendationId>` (the closed rest/train/cardio id set)",
  },
  {
    prefix: "immunization:",
    keyClass: "name-keyed-swept",
    shape: "`<catalogComponentCode>`",
    sweep: "sweepImmunizationDismissals (lib/queries/upcoming/suppressions)",
    // A catalog code rather than a typed name, but #203's finding was that CODES
    // recycle too — a dose delete/re-code un-backs a component code, so the swept
    // class is the honest one even though the vocabulary is curated.
  },

  // ---- anchored: a date / period / episode anchor bounds re-attachment -------
  {
    prefix: "training-obs:",
    keyClass: "anchored",
    shape:
      "`plateau:<movementLoadKey>:<e1rmBucket>` / `stale:<exerciseHistoryKey>:<lapseMonth>` / `balance:push-pull:<heavier>`",
    // The NAME half is already the canonical identity (#1399/#1610 — the same re-key
    // #1931 applies to the PR keys), and the episode anchor (#436) means a new stall
    // at a new working weight is a new key rather than an inherited silence.
  },
  {
    prefix: "muscle-volume:",
    keyClass: "anchored",
    shape:
      "`below:<muscle>:<monthAnchor>` (muscle from the curated anatomy set)",
  },
  {
    prefix: "illness-care:",
    keyClass: "anchored",
    shape: "`<variant>:<episodeAnchor>:<symptom>`",
  },
  {
    prefix: "temp-red-flag:",
    keyClass: "anchored",
    shape: "`<episodeAnchor>:<date>:<ruleKey>`",
  },
  {
    prefix: "mental-health:",
    keyClass: "anchored",
    shape: "`crisis:<instrument>:<date>`",
  },
  {
    prefix: "mood-obs:",
    keyClass: "anchored",
    shape: "`low:<monthAnchor>`",
  },
  {
    prefix: "sleep-mood:",
    keyClass: "anchored",
    shape: "`co:<monthAnchor>`",
  },
  {
    prefix: "sun-exposure:",
    keyClass: "anchored",
    shape: "`daylight:<date>`",
  },
  {
    prefix: "uv-exposure:",
    keyClass: "anchored",
    shape: "`overexposure:<date>`",
  },
  {
    prefix: "poor-sleep-override:",
    keyClass: "anchored",
    shape: "`<date>`",
  },
  {
    prefix: "steps-pace:",
    keyClass: "anchored",
    shape: "`<date>`",
  },
  {
    prefix: "fitness-check:",
    keyClass: "anchored",
    shape: "`retest:<lastCheckDate>`",
  },
  {
    prefix: "ttc-workup:",
    keyClass: "anchored",
    shape: "`<declaredTtcStartDate>`",
  },
  {
    prefix: "cycle-bleeding:",
    keyClass: "anchored",
    shape: "`<periodStartDate>`",
    // KNOWN NARROW EDGE (#1931 audit): a date is not an id. Delete a period and later
    // log one STARTING THE SAME DAY and the prolonged-bleeding dismissal re-attaches.
    // Real but very narrow, and the finding is calm/coaching-tier; recorded here so the
    // next audit doesn't have to re-derive it. No fix proposed.
  },
  {
    prefix: "outdoor-plan:",
    keyClass: "anchored",
    shape: "`<activityHistoryKey>:<weekStartDate>`",
    // The activity name IS recyclable, but the week anchor bounds it: a stale key can
    // only ever silence the same activity in the same already-past week.
  },
  {
    prefix: "portal-sync:",
    keyClass: "anchored",
    shape: "`<portalSlug>/<accountSlug>:<requestDay>`",
  },

  // ---- name-keyed + swept: recyclable strings with a de-orphan sweep ---------
  {
    prefix: "biomarker:",
    keyClass: "name-keyed-swept",
    shape: "`<biomarkerRetestIdentity>` (lowercased)",
    sweep:
      "cleanupOrphanBiomarkerDismissals (lib/queries/upcoming/suppressions), plus migrateRenamedBiomarker on rename",
  },
  {
    prefix: "biomarker-flag:",
    keyClass: "name-keyed-swept",
    shape: "`<biomarkerFamily>` (lowercased)",
    sweep:
      "cleanupOrphanBiomarkerDismissals (lib/queries/upcoming/suppressions), plus migrateRenamedBiomarker on rename",
  },
  {
    prefix: "pr:strength:",
    keyClass: "name-keyed-swept",
    shape: "`<movementLoadKey>:<kind>`",
    sweep: "cleanupOrphanPrDismissals (lib/queries/upcoming/suppressions)",
  },
  {
    prefix: "pr:cardio:",
    keyClass: "name-keyed-swept",
    shape: "`<activityHistoryKey>:<kind>`",
    sweep: "cleanupOrphanPrDismissals (lib/queries/upcoming/suppressions)",
  },

  // ---- name-keyed, unswept: residual risk, stated ----------------------------
  {
    prefix: "digest:",
    keyClass: "name-keyed-open",
    shape: "`<trendSeriesKey>:<direction>`",
    risk:
      "A series key can embed a biomarker name (`bio:<name>`), which recycles. " +
      "Deleting every reading and re-adding the analyte later can re-attach a stale " +
      "chip dismissal. Bounded: a digest chip is calm/coaching-tier, is scoped to one " +
      "DIRECTION (a reversal mints a new key and resurfaces the chip), and only " +
      "renders while the trend is live. Not fixed by #1931; a sweep would have to " +
      "understand every series family, which is a separate piece of work.",
  },

  // ---- legacy: no write path mints these anymore -----------------------------
  {
    prefix: "trajectory:",
    keyClass: "legacy",
    shape: "`<analyte>:<rule>` — pre-#564 rows only",
    risk:
      "Name-keyed and unswept, but BOUNDED: since #564 the trajectory dismiss writes " +
      "`biomarkerFlagDismissalKey(analyte)` (which IS swept) and this per-rule key is " +
      "read-only compatibility for rows stored before that. No new rows are minted, so " +
      "the residue cannot grow.",
  },
  {
    prefix: "med-bridge:",
    keyClass: "legacy",
    shape: "`<medNameKey>` — pre-#1270 rows only",
    risk:
      "The records bridge was removed in #1270; the prefix survives ONLY so an " +
      "already-stored row still resolves to a label and clears via Restore. No " +
      "surface reads it as suppression, so a recycled name cannot inherit anything.",
  },
];

// Prefix constants exported from lib/ that are NOT suppression-bus namespaces. The
// source scan in lib/__tests__/dismissal-classes.test.ts requires every
// `export const *_PREFIX = "…"` literal to be either in DISMISSAL_KEY_REGISTRY or
// here — so a new signal-key prefix cannot ship without someone deciding which it is.
// Each entry states what the prefix actually keys, because "not a dismissal" is a
// claim that has to be checkable.
export const NON_DISMISSAL_PREFIXES: readonly {
  prefix: string;
  what: string;
}[] = [
  {
    prefix: "notify_last_followup_",
    what: "profile_settings one-shot send marker (lib/followup-nudge)",
  },
  {
    prefix: "notify_last_refill_",
    what: "profile_settings one-shot send marker (lib/refill-nudge)",
  },
  {
    prefix: "notify_last_pool_refill_",
    what: "profile_settings one-shot send marker (lib/refill-nudge)",
  },
  {
    prefix: "notify_last_post_workout_",
    what: "profile_settings one-shot send marker (lib/notifications/workout-presence)",
  },
  {
    prefix: "notify_stale_workout_",
    what: "profile_settings one-shot send marker (lib/notifications/workout-presence)",
  },
  {
    prefix: "notify_ease_back_",
    what: "profile_settings one-shot send marker (lib/notifications/ease-back)",
  },
  {
    prefix: "metric:",
    what: "saved_items key namespace for a pinned trend metric (lib/saved-items)",
  },
  {
    prefix: "bio:",
    what: "saved_items / digest SERIES key namespace for a biomarker (lib/saved-items); the bus sees it only inside a `digest:` key",
  },
  {
    prefix: "wellness:",
    what: "digest SERIES key namespace for a practice cadence (lib/trends-practices); the bus sees it only inside a `digest:` key",
  },
  {
    prefix: "document:",
    what: "provenance source tag on an imported row (lib/document-source)",
  },
  {
    prefix: "offline/",
    what: "model tag for an offline-composed narrative (lib/offline-narrative)",
  },
  {
    prefix: "tune",
    what: "Telegram callback-data namespace for digest tuning (lib/notifications/digest-tune)",
  },
  {
    prefix: "tunec",
    what: "Telegram callback-data namespace for digest tuning (lib/notifications/digest-tune)",
  },
  {
    prefix: "tunet",
    what: "Telegram callback-data namespace for digest tuning (lib/notifications/digest-tune)",
  },
  {
    prefix: "offer",
    what: "Telegram callback-data namespace for the offer tail (lib/notifications/offer-tail)",
  },
  {
    prefix: "offerc",
    what: "Telegram callback-data namespace for the offer tail (lib/notifications/offer-tail)",
  },
];

/** The registry entry whose namespace a stored dismissal key belongs to, or null. */
export function dismissalKeyEntryFor(key: string): DismissalKeyEntry | null {
  return DISMISSAL_KEY_REGISTRY.find((e) => key.startsWith(e.prefix)) ?? null;
}

/** Every classified namespace, for the guards and docs. */
export const DISMISSAL_KEY_PREFIXES: readonly string[] =
  DISMISSAL_KEY_REGISTRY.map((e) => e.prefix);

/** Namespaces whose keys embed a user-recyclable name and rely on a sweep. */
export const SWEPT_DISMISSAL_PREFIXES: readonly string[] =
  DISMISSAL_KEY_REGISTRY.filter((e) => e.keyClass === "name-keyed-swept").map(
    (e) => e.prefix
  );

/**
 * The namespaces the display resolver knows, re-exported so a caller comparing the
 * two registries doesn't have to import both. (The guard asserts they are equal.)
 */
export const DISPLAYABLE_DISMISSAL_PREFIXES = SUPPRESSION_DISPLAY_PREFIXES;
