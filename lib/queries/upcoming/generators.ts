// Upcoming-page aggregation. One profile-scoped entry
// point, collectUpcoming(), fans out across the EXISTING forward-looking
// due-signals — reusing each domain's own read + pure helper rather than
// reinventing the logic — and returns a flat UpcomingItem[] for the pure
// banding/sorting layer (lib/upcoming.ts). Every read here is profile-scoped:
// the functions it calls all filter profile_id (enforced by
// lib/__tests__/profile-scoping.test.ts), and the dynamic no-bleed guard lives
// in lib/__db_tests__/upcoming.scoping.test.ts.

import { db } from "../../db";
import { cache } from "../../request-cache";
import { shiftDateStr } from "../../date";
import { isTrainingRestricted } from "../../age-gate";
import {
  signalKey,
  isSuppressed,
  type SuppressionRecord,
} from "../../upcoming-suppress";
import { isDueOn, timeBucket } from "../../supplement-schedule";
import { doseSortKey } from "../../dose-order";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../../refill";
import { refillSignalKey } from "../../refill-nudge";
import { trainingSignalKey } from "../../workout-nudge";
import { assessSchedule } from "../../immunization-status";
import { preventiveAssessmentToUpcomingItem } from "../../preventive-upcoming";
import { scheduledMatchForRule } from "../../preventive-appointment";
import { carePlanUpcomingItems } from "../../care-plan-upcoming";
import {
  isBiomarkerStale,
  retestIntervalDays,
  daysBetween,
} from "../../reference-range";
import { retestDaysForBiomarker } from "../../biomarker-retest";
import {
  biomarkerRetestTitle,
  biomarkerRetestDetail,
} from "../../biomarker-retest-copy";
import {
  retestModulationFor,
  screeningPriorityFor,
  isAnchoredOneShotReading,
} from "../../risk-stratification";
import { lifeStage } from "../../life-stage";
import { getRiskFactors } from "./risk";
import { biomarkerFamily } from "../../canonical-name";
import { biomarkerDismissalKey } from "../../dismissal-keys";
import { derivedInputCanonicalNamesFor } from "../../derived-biomarkers";
import { frequencyScopeLabel } from "../../goals";
import {
  getUserSex,
  getUserAgeOn,
  profileAgeMonths,
  getActiveSituations,
} from "../../settings";
import type { UpcomingItem } from "../../upcoming";
import type { MedicalRecord } from "../../types";
import { pickNextAppointment } from "../../household";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getRefillRates,
  getDietaryLimitWarnings,
  getInteractionWarnings,
} from "../intake";
import {
  dietaryLimitSignalKey,
  ulWarningTitle,
  ulWarningDetail,
} from "../../dri";
import { interactionTitle, interactionDetail } from "../../drug-interactions";
import { getScheduledAppointments, kindedScheduled } from "../appointments";
import {
  getActivitiesByDate,
  getGoals,
  getFrequencyTargetProgress,
} from "../training";
import {
  getMedicalRecords,
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
} from "../medical";
import { getCarePlanItems } from "../clinical";
import { assessProfilePreventive } from "./preventive";
import { getFindingSuppressions } from "./suppressions";

// Biomarker categories a retest nudge makes sense for. Vitals/scans/prescriptions
// aren't "labs to redraw", and genomics never go stale (handled by
// isBiomarkerStale). Kept narrow so the retest signal stays a labs signal. The
// cadence is per-analyte now (curated retest_days, default 365) rather than flat.
const RETEST_CATEGORIES = new Set(["lab", "biomarker"]);

// Doses pending TODAY across active supplements + medications (reuses the
// supplement schedule's isDueOn with today's workout/situation context, and the
// per-dose taken-log read). A PRN (as_needed) med is never scheduled-due, so
// isDueOn already drops it. Only NOT-yet-taken doses are surfaced.
function doseItems(profileId: number, today: string): UpcomingItem[] {
  const supplements = getSupplements(profileId);
  const doses = getSupplementDoses(profileId);
  const taken = getTakenDoseIds(profileId, today);
  const activeSituations = new Set(getActiveSituations(profileId));
  const isWorkoutDay = getActivitiesByDate(profileId, today).length > 0;
  const ctx = { isWorkoutDay, activeSituations };

  const byId = new Map(supplements.map((s) => [s.id, s]));
  const items: UpcomingItem[] = [];
  for (const dose of doses) {
    if (taken.has(dose.id)) continue;
    const supp = byId.get(dose.item_id);
    if (!supp || !supp.active || !isDueOn(supp, ctx)) continue;
    const detail = [
      supp.kind === "medication" ? "Medication" : null,
      dose.amount,
    ]
      .filter(Boolean)
      .join(" · ");
    items.push({
      key: `dose:${dose.id}`,
      domain: "dose",
      title: supp.name,
      detail: detail || null,
      href: "/medicine",
      dueDate: null, // scheduled for today
      // Bucket label as the due-text ("Morning" / "Evening" / "Before sleep"…):
      // informative on its own and it explains the ordering to the user (#297).
      dueText: timeBucket(dose.time_of_day),
      // Shared dose-day sort key (bucket → priority → stack → name) so morning
      // and bedtime doses no longer interleave alphabetically within the band —
      // the SAME ordering /medicine's due-today section uses (#297).
      sortHint: doseSortKey({
        timeOfDay: dose.time_of_day,
        priority: supp.priority,
        stack: supp.stack,
        name: supp.name,
      }),
      doseId: dose.id,
    });
  }
  return items;
}

// Tracked meds/supplements running low on supply (reuses lib/refill's pure math;
// doses/day comes from the shared getRefillRates — the ACTUAL taken-log rate when
// history is thick enough, else the scheduled-dose-count estimate — matching the
// supplements page and refill notifier). The estimated run-out date (today +
// days-left) drives the band, so an item with 0 days left lands in Today and a
// week of runway lands in This week.
function refillItems(profileId: number, today: string): UpcomingItem[] {
  const tracked = getSupplements(profileId).filter(
    (s) => s.active && s.quantity_on_hand != null
  );
  if (tracked.length === 0) return [];
  const rates = getRefillRates(profileId);

  const items: UpcomingItem[] = [];
  for (const s of tracked) {
    const daysLeft = daysOfSupplyLeft(
      s.quantity_on_hand,
      s.qty_per_dose,
      rates.get(s.id)?.dosesPerDay ?? 0
    );
    if (!isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS) || daysLeft == null)
      continue;
    items.push({
      key: refillSignalKey(s.id),
      domain: "refill",
      title: s.name,
      detail:
        daysLeft <= 0 ? "Out of supply" : `≈${daysLeft} days of supply left`,
      href: "/medicine",
      dueDate: shiftDateStr(today, daysLeft),
    });
  }
  return items;
}

// Supplement stack totals that exceed an NIH Tolerable Upper Intake Level (issue
// #148). Reuses the shared getDietaryLimitWarnings gather (same computation as the
// /medicine warning rows), so a nutrient over its UL surfaces as a dismissible
// finding keyed by `dietary-limit:<nutrient>` — it goes through getFindingSuppressions
// like every other finding, so a dismiss/snooze on Upcoming silences it. Standing
// informational findings (no due date): banded to Today, framed "discuss with your
// clinician", never prescriptive.
function dietaryLimitItems(profileId: number, today: string): UpcomingItem[] {
  return getDietaryLimitWarnings(profileId, today).map((w) => ({
    key: dietaryLimitSignalKey(w.key),
    domain: "dietary-limit" as const,
    title: ulWarningTitle(w),
    detail: ulWarningDetail(w),
    href: "/medicine",
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Known drug-/supplement-interactions among the profile's ACTIVE stack (issue #144).
// Reuses the shared getInteractionWarnings gather (same pure detectInteractions the
// /medicine warning rows format over), so each interacting PAIR surfaces as a
// dismissible finding keyed by `interaction:<lo>-<hi>` — it goes through
// getFindingSuppressions like every other finding, so a dismiss/snooze on Upcoming
// silences it ("dismiss once, silence everywhere"). Standing informational findings
// (no due date): banded to Today, framed "discuss with your prescriber", never
// prescriptive.
function interactionItems(profileId: number): UpcomingItem[] {
  return getInteractionWarnings(profileId).map((hit) => ({
    key: hit.dedupeKey,
    domain: "interaction" as const,
    title: interactionTitle(hit),
    detail: interactionDetail(hit),
    href: "/medicine",
    dueDate: null,
    band: "today" as const,
    dueText: "Review",
  }));
}

// Vaccines due/overdue on the tracked schedule (reuses assessSchedule + the same
// age/sex resolution the immunizations page uses). Status-driven, so each item
// carries an explicit band + due-text rather than a calendar date.
function immunizationItems(profileId: number, today: string): UpcomingItem[] {
  const sex = getUserSex(profileId);
  const ageMonths = profileAgeMonths(profileId, today);

  const summary = assessSchedule(
    getImmunizations(profileId).map((r) => ({
      vaccine: r.vaccine,
      date: r.date,
    })),
    ageMonths,
    sex,
    today,
    getImmunityTiters(profileId).map((t) => ({
      marker: t.marker,
      status: t.status,
    })),
    getImmunizationOverrides(profileId).map((o) => ({
      vaccine: o.vaccine,
      kind: o.kind,
    }))
  );

  return summary.assessments
    .filter((a) => a.status === "overdue" || a.status === "due")
    .map((a) => ({
      key: `immunization:${a.code}`,
      domain: "immunization" as const,
      title: a.name,
      detail: a.nextLabel ?? a.detail,
      href: "/immunizations",
      dueDate: null,
      band: a.status === "overdue" ? ("overdue" as const) : ("today" as const),
      dueText: a.status === "overdue" ? "Overdue" : "Due",
    }));
}

// Maps the preventive actionable slice into Upcoming items, adding the prefilled
// "Book" CTA and — when a matching-kind visit is already booked (issue #85) — a
// quiet "Scheduled" state (from the profile's still-scheduled appointments). The
// underlying assessment is assessProfilePreventive (./preventive), shared with the
// proactive nudge so the page and the push can never diverge on WHICH items are due.
function preventiveItems(profileId: number, today: string): UpcomingItem[] {
  const scheduled = kindedScheduled(profileId);
  // Risk-stratified priority (issue #517): a screening the profile's risk factors
  // make more important (family cardiac history → lipid screening) ranks up and
  // says why, in a calm line. Cadence of the catalog is unchanged — this is the
  // ranking + explanation side only.
  const riskFactors = getRiskFactors(profileId);
  return assessProfilePreventive(profileId, today).actionable.map((a) => {
    const item = preventiveAssessmentToUpcomingItem(a, {
      today,
      scheduledDate: scheduledMatchForRule(a.key, scheduled, today),
    });
    const { priority, reasons } = screeningPriorityFor(a.key, riskFactors);
    if (priority > 0) {
      item.priority = priority;
      const suffix = reasons.join(", ");
      item.detail = item.detail ? `${item.detail} · ${suffix}` : suffix;
    }
    return item;
  });
}

// Approximate whole months for a span of days, for the cadence due-text
// ("every 12mo", "tested 14mo ago"). Clamped to at least 1 so a sub-month cadence
// still reads sensibly.
function monthsApprox(days: number): number {
  return Math.max(1, Math.round(days / 30.44));
}

// Biomarkers whose latest reading is past their PER-ANALYTE retest window (reuses
// getMedicalRecords' current-per-group read + isBiomarkerStale, now consulting the
// curated retest_days). The retest-due date is the last reading + that analyte's
// interval, so a quarterly HbA1c reads as overdue far sooner than an annual lipid
// panel; uncurated analytes keep the flat 365-day fallback.
//
// Readings are grouped by the ONE #482 biomarker FAMILY identity (biomarkerFamily),
// the same grouping the dedup/series/starred surfaces use — so almost every analyte
// is its own family (keyed by canonical name), but the interchangeable-name families
// (the 25-hydroxy vitamin-D variants total/generic/D2/D3, and A1c ↔ eAG) collapse
// into one: a recent reading of ANY member supersedes an old sibling, so the stale
// variants don't each nag as overdue when a fresh family reading exists. Per family
// we keep the NEWEST reading; its name → the stable family `biomarker:<family>`
// dismissal key (via biomarkerDismissalKey), so a dismiss on any member silences the
// family and the key doesn't drift as which member is newest changes.
//
// DERIVED-analyte freshness (#482 scope 2): a stored derived index (Non-HDL, eGFR…)
// inherits its INPUTS' freshness — re-drawing Total + HDL re-derives Non-HDL — so we
// take the newest of (the reading, its input readings) as the effective last-tested
// date. A non-derived analyte has no inputs, so its effective date is just its own.
function biomarkerItems(profileId: number, today: string): UpcomingItem[] {
  const latest = getMedicalRecords(profileId, { current: true });
  // Newest reading date per family across ALL current readings — the input→derived
  // freshness lookup below reads an input analyte's family date from here.
  const latestDateByFamily = new Map<string, string>();
  for (const r of latest) {
    const fam = biomarkerFamily(r.canonical_name?.trim() || r.name);
    const prev = latestDateByFamily.get(fam);
    if (!prev || r.date > prev) latestDateByFamily.set(fam, r.date);
  }
  const byFamily = new Map<string, MedicalRecord>();
  for (const r of latest) {
    if (!RETEST_CATEGORIES.has(r.category ?? "")) continue;
    const famKey = biomarkerFamily(r.canonical_name?.trim() || r.name);
    const prev = byFamily.get(famKey);
    // Newest wins; tie-break on higher id (later-entered), matching
    // getMedicalRecords' "date DESC, id DESC" current-reading ranking.
    if (!prev || r.date > prev.date || (r.date === prev.date && r.id > prev.id))
      byFamily.set(famKey, r);
  }
  // Risk-stratified cadence + priority (issue #517): family history, active
  // conditions, and the occupational/immune attributes tighten an analyte's retest
  // interval and rank it up. Gathered once per profile (request-cached).
  const riskFactors = getRiskFactors(profileId);
  const items: UpcomingItem[] = [];
  for (const r of byFamily.values()) {
    const name = r.canonical_name?.trim() || r.name;
    const retestDays = retestDaysForBiomarker(r.canonical_name?.trim() || null);
    // Fold in input freshness for a derived analyte (empty for everything else).
    let effectiveDate = r.date;
    for (const input of derivedInputCanonicalNamesFor(
      r.canonical_name?.trim() || ""
    )) {
      const inputDate = latestDateByFamily.get(biomarkerFamily(input));
      if (inputDate && inputDate > effectiveDate) effectiveDate = inputDate;
    }
    // Anchored one-shot (issue #517): a newborn analyte (bilirubin / metabolic
    // screen) drawn in infancy is a life-stage milestone, not a recurring retest —
    // skip it entirely so it never nags on a yearly clock. Age is resolved on the
    // READING date, so an adult bilirubin stays a normal recurring LFT.
    if (
      isAnchoredOneShotReading(
        name,
        lifeStage(getUserAgeOn(profileId, effectiveDate))
      )
    )
      continue;
    // Modulate the cadence by the matched risk rules (tightest multiplier wins),
    // then test staleness + band against the MODULATED interval so a high-risk
    // analyte comes due sooner.
    const mod = retestModulationFor(name, riskFactors);
    const interval = Math.max(
      1,
      Math.round(retestIntervalDays(retestDays) * mod.multiplier)
    );
    // Immune-positive durable-immunity titers never go stale (#516) — pass the
    // reading's identity + result so isBiomarkerStale can exempt them. A negative/
    // equivocal titer keeps the (risk-modulated) clock, so the risk layer's
    // hepatitis-A tightening still bites exactly the readings that warrant followup.
    if (
      !isBiomarkerStale(effectiveDate, r.category, today, interval, {
        name,
        flag: r.flag,
        value: r.value,
        notes: r.notes,
        reference: r.reference_range,
      })
    )
      continue;
    const agoMonths = monthsApprox(daysBetween(effectiveDate, today));
    items.push({
      key: biomarkerDismissalKey(name),
      domain: "biomarker",
      // The item is a retest nudge, not a flag alert — carry the verb so it reads
      // as an action, and (when the stale reading was flagged) acknowledge the
      // status in the detail so the row explains itself (issues #513 / #514).
      title: biomarkerRetestTitle(name),
      detail: biomarkerRetestDetail({
        effectiveDate,
        agoMonths,
        intervalMonths: monthsApprox(interval),
        flag: r.flag,
        reasons: mod.reasons,
      }),
      href: r.canonical_name?.trim()
        ? `/biomarkers/view?name=${encodeURIComponent(name)}`
        : "/biomarkers",
      dueDate: shiftDateStr(effectiveDate, interval),
      priority: mod.priority,
    });
  }
  return items;
}

// Scheduled medical visits (reuses getScheduledAppointments — only 'scheduled'
// rows, so completed/cancelled drop off). The visit's calendar date drives the
// band: a visit today lands in Today, tomorrow in This week, and a past-and-still-
// scheduled one reads as Overdue (a missed/unlogged appointment worth chasing).
function appointmentItems(profileId: number): UpcomingItem[] {
  return getScheduledAppointments(profileId).map((a) => {
    // scheduled_at may be a datetime; the banding is calendar-day, so use the date.
    const dueDate = a.scheduled_at.slice(0, 10);
    const parts = [a.provider_name, a.location].filter(Boolean);
    return {
      key: `appointment:${a.id}`,
      domain: "appointment" as const,
      title: a.title?.trim() || a.provider_name || "Appointment",
      detail: parts.length ? parts.join(" · ") : "Scheduled visit",
      href: "/encounters",
      dueDate,
    };
  });
}

// Active goals with a target date (reuses getGoals). The deadline drives the
// band, so an overdue deadline reads as Overdue and an approaching one as
// Today/This week/Later. Goals live on the Training hub's Goals tab — the old
// standalone /goals route has no page (issue #283 found the dead link).
function goalItems(profileId: number): UpcomingItem[] {
  return getGoals(profileId)
    .filter((g) => !g.archived && g.status === "active" && g.target_date)
    .map((g) => ({
      key: `goal:${g.id}`,
      domain: "goal" as const,
      title: g.title,
      detail: g.category ? `${g.category} goal` : "Goal deadline",
      href: "/training?tab=goals",
      dueDate: g.target_date,
    }));
}

// Unmet weekly frequency targets (reuses getFrequencyTargetProgress). Hidden for
// age-restricted profiles, mirroring the Training surface. A weekly concern, so
// each unmet target sits in This week with a progress due-text.
function trainingItems(profileId: number): UpcomingItem[] {
  if (isTrainingRestricted(profileId)) return [];
  return getFrequencyTargetProgress(profileId)
    .filter((p) => !p.met)
    .map((p) => ({
      key: trainingSignalKey(p.target.id),
      domain: "training" as const,
      title: frequencyScopeLabel(p.target.scope_kind, p.target.scope_value),
      detail: "Weekly training target",
      href: "/training",
      dueDate: null,
      band: "week" as const,
      dueText: `${p.count}/${p.per_week} this week`,
    }));
}

// Provider-ordered / manually-entered care-plan items with a planned date (issue
// #84). Reuses getCarePlanItems (profile-scoped read) and the pure adapter, which
// keeps only OPEN (non-completed/cancelled) DATED items and bands them by their
// real planned_date. Each carries its row id for the inline "Mark done" form.
// NOTE (v1): no dedup yet against the preventive-care engine — an ordered
// colonoscopy and a catalog "colorectal screening due" can both appear; the issue
// punts that to a follow-up.
function carePlanItems(profileId: number): UpcomingItem[] {
  return carePlanUpcomingItems(getCarePlanItems(profileId));
}

// Mark a care-plan item completed (issue #84) — the write behind the Upcoming
// "Mark done" fast path. Sets status = 'completed' so the pure adapter drops it
// from the due-list on the next read. Profile-scoped (WHERE id AND profile_id), so
// a tampered id for another profile is a no-op.
export function markCarePlanItemDone(profileId: number, id: number): void {
  db.prepare(
    "UPDATE care_plan_items SET status = 'completed' WHERE id = ? AND profile_id = ?"
  ).run(id, profileId);
}

// Every forward-looking due-signal for the active profile, BEFORE snooze/dismiss
// filtering. `today` is resolved by the caller in the profile's timezone.
//
// Wrapped in request-scoped cache() (issue #389): the /upcoming page runs BOTH
// collectUpcoming and collectSuppressedUpcoming, and each independently fans out the
// full generator set (2× assessProfilePreventive's medical_records/encounters/
// appointments/procedures/care-plan reads, 2× everything else). cache() collapses
// the two calls in one request to a single fan-out. Outside a server request (the
// notify tick, DB tests) cache() degrades to a plain passthrough, so behavior is
// unchanged — the digest reuse still recomputes per call as before.
const rawUpcoming = cache(function rawUpcoming(
  profileId: number,
  today: string
): UpcomingItem[] {
  return [
    ...doseItems(profileId, today),
    ...refillItems(profileId, today),
    ...dietaryLimitItems(profileId, today),
    ...interactionItems(profileId),
    ...appointmentItems(profileId),
    ...carePlanItems(profileId),
    ...preventiveItems(profileId, today),
    ...immunizationItems(profileId, today),
    ...biomarkerItems(profileId, today),
    ...goalItems(profileId),
    ...trainingItems(profileId),
  ];
});

// Whether an item is currently hidden by a snooze/dismiss row in `map`.
function isItemSuppressed(
  map: Map<string, SuppressionRecord>,
  item: UpcomingItem,
  today: string
): boolean {
  const rec = map.get(signalKey(item));
  return rec != null && isSuppressed(rec, today);
}

// Aggregate every forward-looking due-signal for the active profile into a flat
// UpcomingItem[], with snoozed/dismissed items filtered out. `today` is resolved
// by the caller in the profile's timezone. Read-only and fully profile-scoped.
// The Telegram digest reuses this, so a suppression applies to the push too.
export function collectUpcoming(
  profileId: number,
  today: string
): UpcomingItem[] {
  const map = getFindingSuppressions(profileId);
  return rawUpcoming(profileId, today).filter(
    (item) => !isItemSuppressed(map, item, today)
  );
}

// The actionable household rollup for ONE profile (issue #31): the subset of the
// Upcoming aggregation the Household cards act on — due doses, low refills, and
// the single soonest scheduled visit. It reuses the SAME per-domain builders as
// collectUpcoming (no duplicated aggregation), but deliberately skips the heavier
// immunization/biomarker/goal/training domains the cards don't render, and honors
// the same snooze/dismiss suppressions so a finding hidden on Upcoming stays
// hidden here too.
//
// COST: the Household page calls this once per ACCESSIBLE profile. It is bounded —
// a household is a handful of profiles — and each call is a few cheap, indexed,
// profile-scoped reads: supplements + their doses + today's taken-log (doseItems),
// the refill rates (refillItems), the scheduled appointments (appointmentItems),
// and the suppressions map. No cross-profile SQL; every read filters profile_id.
export interface HouseholdRollup {
  dueDoses: UpcomingItem[];
  lowRefills: UpcomingItem[];
  nextAppointment: UpcomingItem | null;
}

export function collectHouseholdRollup(
  profileId: number,
  today: string
): HouseholdRollup {
  const map = getFindingSuppressions(profileId);
  const live = (item: UpcomingItem) => !isItemSuppressed(map, item, today);
  return {
    dueDoses: doseItems(profileId, today).filter(live),
    lowRefills: refillItems(profileId, today).filter(live),
    nextAppointment: pickNextAppointment(
      appointmentItems(profileId).filter(live)
    ),
  };
}

// A currently-suppressed item plus why it's hidden — powers the Upcoming page's
// "Snoozed & dismissed" section, where each entry offers a Restore.
export interface SuppressedUpcoming {
  item: UpcomingItem;
  signalKey: string;
  snoozeUntil: string | null;
  dismissedAt: string | null;
}

// The items that ARE currently snoozed/dismissed for this profile (the complement
// of collectUpcoming over the same raw set). Profile-scoped; used by the restore
// UI. A snooze that has since expired is NOT included (its item is live again).
export function collectSuppressedUpcoming(
  profileId: number,
  today: string
): SuppressedUpcoming[] {
  const map = getFindingSuppressions(profileId);
  const out: SuppressedUpcoming[] = [];
  for (const item of rawUpcoming(profileId, today)) {
    const rec = map.get(signalKey(item));
    if (rec && isSuppressed(rec, today)) {
      out.push({
        item,
        signalKey: signalKey(item),
        snoozeUntil: rec.snooze_until,
        dismissedAt: rec.dismissed_at,
      });
    }
  }
  return out;
}
