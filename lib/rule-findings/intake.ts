// Intake and medication rule findings (#2962).
//
// Adherence patterns and obligation demotion share the dose schedule (lib/intake-
// schedule) and the one item-level history gather, and the therapeutic-duplication note
// is the medication half of the same page. All three are observations ABOUT a profile's
// intake record; none of them writes an obligation — the user's tap is the only write.

import { profileDayZone, travelExcusalResolver } from "../travel-excusal";
import {
  getIntakeItems,
  getIntakeDoses,
  getIntakeAdherenceEvidence,
  getActivityDates,
  getActiveMedicationFamilies,
} from "../queries";
import { effectiveSituationResolver } from "../queries/derived-situations";
import { getIntakeHistory } from "../intake-history";
import {
  detectDemotionCandidates,
  demotionItemIdFromKey,
  DEMOTION_WINDOW_DAYS,
  type DemotionInput,
} from "../supplement-demotion";
import { isOnDemand } from "../intake-schedule";
import { lastNDates } from "../date";
import {
  FINDING_DASHBOARD_RELEVANCE,
  type Finding,
  type RollupOnlyFinding,
} from "../findings";
import { nutritionTabHref, MEDICATIONS_HREF } from "../hrefs";
import {
  medDupSignalKey,
  medicationDuplicationNote,
} from "../medication-family";
import {
  detectAdherencePatterns,
  ADHERENCE_PATTERN_DAYS,
  type AdherencePattern,
  type DoseAdherenceInput,
} from "../adherence-patterns";
import {
  doseStrip,
  doseWindowSince,
  indexTakenByDose,
  stripWithoutTrailingPending,
} from "../intake-adherence";
import {
  doseDueOn,
  doseSlotChangedSince,
  timeBucket,
} from "../intake-schedule";
import { unrecordedScheduleChangeOn } from "../intake-cadence";
import { COACHING_ENTITY_FINDING_LIMITS } from "./limits";

// ---- Medication therapeutic-duplication note (#1027 ask 3) ------------------

// ONE calm observation per ingredient FAMILY with two or more ACTIVE medication
// members ("Ibuprofen appears in 2 active medications") — the visibility half of the
// #1027 cross-item counters (the family-wide redose/over-max math is the protective
// half). COACHING tier deliberately (#449): it joins collectCoachingFindings, its
// dedupeKey (`med-dup:<familyKey>`, MED_DUP_PREFIX registered in
// RULE_FINDING_PREFIXES) rides the shared suppression bus, and it NEVER notifies /
// never reaches the hero — tracking both an OTC and an Rx strength is often
// deliberate, so this is informational posture only. Reads through the ONE
// profile-scoped family gather (getActiveMedicationFamilies), so the note and the
// widened counters can never disagree about what a family is. The familyKey is
// derived (CUI-first, cleaned-name fallback) — per #203, resolving/renaming a member
// re-keys the family and an old dismissal goes inert (it resurfaces once).
//
// The COPY splits on the members' distinguishability (#3069,
// medicationDuplicationNote): an INDISTINGUISHABLE family — one name key, no
// strength telling any two members apart — is duplicate RECORDS (the #2919 fold
// escape), and the note says so instead of calling "albuterol + albuterol +
// albuterol" deliberate; a distinguishable family keeps the original #1027 copy
// unchanged. Only the copy splits: the key, tier, action and the family math all
// stay as they were, so an existing dismissal keeps suppressing either rendering.
export function buildMedicationDuplicationFindings(
  profileId: number
): RollupOnlyFinding[] {
  const findings: { finding: RollupOnlyFinding; newestMemberId: number }[] = [];
  for (const family of getActiveMedicationFamilies(profileId)) {
    if (family.members.length < 2) continue;
    const copy = medicationDuplicationNote(family.members);
    findings.push({
      // The id of the member that made the family a duplicate — ids are AUTOINCREMENT
      // and never recycle (#203), so the largest is the most recently added.
      newestMemberId: Math.max(...family.members.map((m) => m.id)),
      finding: {
        domain: "med-dup",
        dedupeKey: medDupSignalKey(family.familyKey),
        title: copy.title,
        detail: copy.detail,
        tone: "info",
        dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
        evidence: copy.evidence,
        actionHref: MEDICATIONS_HREF,
        actionLabel: "View medications",
      },
    });
  }
  // Most recently added duplicate first (#4069): the cap below truncates on this
  // order, and the family a profile just created a second member in is the one the
  // note is about. The sort is stable, so families that gained their newest member in
  // the same write keep getActiveMedicationFamilies' first-member input order — the
  // pre-ruling order, preserved as the tie-break.
  return findings
    .sort((a, b) => b.newestMemberId - a.newestMemberId)
    .slice(0, COACHING_ENTITY_FINDING_LIMITS.medicationDuplication)
    .map((x) => x.finding);
}

// ---- Domain 3: adherence pattern detection (Supplements & Meds) ------------

// An adherence-pattern observation → the shared Finding envelope. Calm/observational
// ("info" tone, like a stale-exercise FYI), deep-linking to the intake surface where
// the dose can be re-timed.
function adherencePatternToFinding(p: AdherencePattern): Finding {
  return {
    domain: `adherence-${p.kind}`,
    dedupeKey: p.key,
    // Honor a pre-#436 dismissal under the episode-less key (#436 dual-read).
    supersedes: p.legacyKey,
    title: p.title,
    detail: p.detail,
    tone: "info",
    actionHref: nutritionTabHref("supplements"),
    actionLabel: "View schedule",
  };
}

// Every adherence-pattern finding for a profile: scheduled doses whose misses
// cluster on a specific weekday ("most Fridays") or on weekends, each suggesting a
// concrete schedule edit. Reuses the same doseStrip / isDueOn machinery the medicine
// page's adherence strip is built from (one question, one computation) over a longer
// ADHERENCE_PATTERN_DAYS window, so a pattern and the strip it summarizes can't
// disagree. PRN/paused items and retired doses are excluded (they're never
// scheduled-due). Not suppression-filtered — the caller applies the shared
// findings-bus filter. No owned SQL is added here (it reads through profile-scoped
// queries), so the profile-scoping guard is unaffected.
export function buildAdherencePatternFindings(
  profileId: number,
  today: string
): Finding[] {
  const items = getIntakeItems(profileId);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const doses = getIntakeDoses(profileId);
  // The profile's timezone resolves the UTC creation stamps onto the same profile-local
  // calendar the `dates` window is built from (#1442) — through the zone in force at
  // each stamp (#4025). BOTH halves of the bound below take it: the lifetime and the
  // legacy re-time reduce through one `max`, so a zone converted on one side only lets
  // the unconverted side win the comparison and walk the day forward again (#4030).
  const dayZone = profileDayZone(profileId);
  // THE EVIDENCE, NOT THE WINDOW (#3988/#4020). This index answers two questions, and
  // only one of them is windowed: "was this dose taken on this drawn day" is, "when did
  // this dose first exist" is not. `getIntakeAdherenceEvidence` unions the window with
  // each dose's earliest log ever, so a reconciled med whose only proof of existence is
  // a backfilled administration older than 56 days is bounded at that proof rather than
  // at `created_at` — the sixth and last caller of that bound to join the other five.
  // The extra rows are all older than the window, so no drawn day's verdict moves.
  const takenByDose = indexTakenByDose(
    getIntakeAdherenceEvidence(profileId, ADHERENCE_PATTERN_DAYS)
  );
  const dates = lastNDates(today, ADHERENCE_PATTERN_DAYS);
  const workoutDays = new Set(getActivityDates(profileId));
  const isExcused = travelExcusalResolver(profileId);
  // Per-day DUENESS resolver (#654/#3993): a past day is scored against what held THAT
  // day, declared AND derived, not today's toggle applied retroactively.
  //
  // This is the widest walk in the app — ADHERENCE_PATTERN_DAYS = 56 days, on the
  // dashboard — and it is the one the cost objection was really about. It costs one
  // gather now, not 56: the resolver reads each derived input once for the declared
  // window. A pattern therefore counts exactly the days the strip it summarizes counts.
  const situationsOn = effectiveSituationResolver(profileId, {
    from: dates[0],
    to: today,
  });

  const inputs: DoseAdherenceInput[] = [];
  for (const d of doses) {
    const item = itemById.get(d.item_id);
    // Only active, scheduled (non-PRN) items produce due days to miss.
    if (!item || !item.active || isOnDemand(item)) continue;
    const status = takenByDose.get(d.id);
    // Clamp the window to the dose's EXISTENCE, and to nothing else (#1973).
    //
    // It used to be clamped at the dose's `updated_at` as well (#430), which meant any
    // re-time voided every day before it: the "editing a dose must not rewrite adherence
    // history" invariant was being honoured by throwing the history away. Effective-dated
    // schedules (migration 151) removed the need — `doseDueOn` below resolves the version
    // in force on each day, so a pre-edit day is judged by the pre-edit rule instead of
    // being dropped. What remains is the genuinely different question of when the dose
    // existed at all, and `doseWindowSince` is its better answer: timezone-aware, and
    // WIDENED by logged history, because a log is proof the dose existed on its date
    // (#1442). It is the same bound the adherence strip clamps to, AND — since #4020 —
    // computed from the same evidence, so a pattern and the strip it summarizes cannot
    // disagree about a day (#221). Both halves are needed: one caller of this bound fed
    // it a windowed read for a year, and the rule agreeing was never the part at risk.
    const exists = doseWindowSince(
      item.created_at,
      d.created_at,
      status,
      dayZone
    );
    // …plus the ONE case effective-dating cannot reach: a dose re-timed BEFORE #1973
    // shipped, whose old slot no version records. `updated_at` says a change happened
    // but not what it replaced, so those days cannot be judged — and judging them by
    // today's rule would be the retroactive re-accusation #430 clamped to avoid. The
    // conservative bound stays for exactly those doses, and only until their next
    // schedule edit records a real version (see unrecordedScheduleChangeOn).
    const unrecorded = unrecordedScheduleChangeOn(d, dayZone);
    const since = [exists, unrecorded]
      .filter((v): v is string => v != null)
      .reduce<string | null>((a, b) => (a == null || b > a ? b : a), null);
    const windowDates = since ? dates.filter((date) => date >= since) : dates;
    const strip = stripWithoutTrailingPending(
      doseStrip(
        windowDates,
        (date) =>
          doseDueOn(item, d, {
            date,
            isWorkoutDay: workoutDays.has(date),
            activeSituations: situationsOn(date),
            // A CLOSED DAY HAS NO PREDICTION (#5321). `null` is the state
            // `conditionAppliesOn` falls back to `isWorkoutDay` on, so the day
            // is judged by the training on its record rather than by a rhythm
            // inferred today.
            predictedWorkoutDay: null,
          }),
        status?.taken ?? new Set(),
        status?.skipped ?? new Set(),
        // Travel (#3263): a slot the profile's own wall clock jumped over is not a
        // lapse, and a detector that counted it would accuse somebody of a habit
        // their flight invented.
        (date) => isExcused(d.time_of_day, date)
      )
    );
    inputs.push({
      doseId: d.id,
      itemName: item.name,
      bucket: timeBucket(d.time_of_day),
      strip,
      // Episode anchor = the current year (#436): a same-weekday habit that recurs a
      // year after being dismissed lands in a new period and re-surfaces, rather than
      // one dismissal silencing it forever.
      periodAnchor: today.slice(0, 4),
      // "Move it earlier" is wrong advice for a bedtime slot or a prescribed
      // medication (#430.4) — fall back to the neutral reminder copy. It is equally
      // wrong for a dose the person ALREADY MOVED inside this window (#1973): the days
      // now stay in the window and are judged honestly by the slot they sat in, but
      // telling someone to move a dose they re-timed last Tuesday is the re-accusation
      // #430 clamped the whole window to avoid. Suppressing the suggestion is the
      // proportionate answer; erasing the history was not.
      suppressMoveSuggestion:
        timeBucket(d.time_of_day) === "Before sleep" ||
        item.kind === "medication" ||
        (windowDates.length > 0 &&
          doseSlotChangedSince(d, windowDates[0], dayZone)),
    });
  }

  return detectAdherencePatterns(inputs)
    .slice(0, COACHING_ENTITY_FINDING_LIMITS.adherencePattern)
    .map(adherencePatternToFinding);
}

// ---- Domain: obligation demotion suggestions (coaching tier, issue #1505) ----

// A calm, dismissible SUGGESTION that a `must`/`should` SUPPLEMENT the profile has
// effectively stopped taking move to `may` — "tracked, never pushed" — with the
// user's tap as the only obligation write (#559 intact; see lib/supplement-demotion for
// the full contract and the medication/PRN/paused/cold-start exclusions).
//
// COACHING tier (#449) by hard product contract: it joins collectCoachingFindings,
// rides the shared suppression bus under DEMOTION_PREFIX, renders on the Supplements
// page and the calm dashboard rollup — and NEVER becomes a notification. Nagging
// someone about a supplement they have chosen not to take is precisely the failure
// mode this whole issue exists to remove, so it must not arrive as a push.
//
// Reads through the ONE shared item-level history gather (getIntakeHistory), the same
// evidence the digest deltas read, so the suggestion and the digest can never
// disagree about a day. No owned SQL.
export function buildDemotionSuggestionFindings(
  profileId: number,
  today: string
): Finding[] {
  const inputs: DemotionInput[] = getIntakeHistory(
    profileId,
    today,
    DEMOTION_WINDOW_DAYS
  ).map(({ item, strip, existedWholeWindow }) => ({
    itemId: item.id,
    name: item.name,
    kind: item.kind,
    obligation: item.obligation,
    asNeeded: Boolean(isOnDemand(item)),
    active: Boolean(item.active),
    strip,
    existedWholeWindow,
    // Episode anchor = the current year (#436): a lapse that recurs a year after
    // being dismissed re-surfaces instead of being silenced forever.
    periodAnchor: today.slice(0, 4),
  }));

  return detectDemotionCandidates(inputs)
    .slice(0, COACHING_ENTITY_FINDING_LIMITS.demotionSuggestion)
    .map((c) => ({
      domain: "demote-obligation",
      dedupeKey: c.key,
      supersedes: c.legacyKey,
      title: c.title,
      detail: c.detail,
      // Calm FYI — an observation about the user's own log, never an alarm.
      tone: "info" as const,
      evidence: `${c.takenDays} of ${c.occurrences} scheduled days over the last ${DEMOTION_WINDOW_DAYS} days`,
      actionHref: nutritionTabHref("supplements"),
      actionLabel: "Open supplements",
    }));
}

// The item ids that are live demotion candidates right now (#1505 part 2) — the SAME
// detection the page card renders, exposed as a set so the reminder builder can add
// its ⤓ May button without re-deriving the threshold.
//
// Deliberately NOT bus-filtered: a page dismissal hides the CARD, not the button
// (owner-decided). The two surfaces answer different questions — "not on this screen"
// versus "is there still an escape hatch" — and conflating them would take the only
// affordance a tap-only user has away on a tap they made somewhere else entirely.
export function demotionCandidateItemIds(
  profileId: number,
  today: string
): Set<number> {
  const ids = new Set<number>();
  for (const f of buildDemotionSuggestionFindings(profileId, today)) {
    const id = demotionItemIdFromKey(f.dedupeKey);
    if (id != null) ids.add(id);
  }
  return ids;
}
