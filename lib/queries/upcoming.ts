// Upcoming-page aggregation (issue #213, Phase 1). One profile-scoped entry
// point, collectUpcoming(), fans out across the EXISTING forward-looking
// due-signals — reusing each domain's own read + pure helper rather than
// reinventing the logic — and returns a flat UpcomingItem[] for the pure
// banding/sorting layer (lib/upcoming.ts). Every read here is profile-scoped:
// the functions it calls all filter profile_id (enforced by
// lib/__tests__/profile-scoping.test.ts), and the dynamic no-bleed guard lives
// in lib/__db_tests__/upcoming.scoping.test.ts.

import { db } from "../db";
import { ageInMonthsFromBirthdate, shiftDateStr } from "../date";
import { isTrainingRestricted } from "../age-gate";
import {
  signalKey,
  isSuppressed,
  type SuppressionRecord,
} from "../upcoming-suppress";
import { isDueOn } from "../supplement-schedule";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../refill";
import { assessSchedule } from "../immunization-status";
import {
  assessCatalog,
  type PreventiveOverride,
  type PreventiveOverrideKind,
  type PreventiveSatisfaction,
} from "../preventive-status";
import { preventiveAssessmentToUpcomingItem } from "../preventive-upcoming";
import {
  isBiomarkerStale,
  retestIntervalDays,
  daysBetween,
} from "../reference-range";
import { retestDaysForBiomarker } from "../biomarker-retest";
import { frequencyScopeLabel } from "../goals";
import {
  getUserSex,
  getUserBirthdate,
  getStoredAge,
  getActiveSituations,
  getSmokingHistory,
} from "../settings";
import { resolveSmoking } from "../smoking";
import type { UpcomingItem } from "../upcoming";
import { pickNextAppointment } from "../household";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getRefillRates,
} from "./intake";
import { getScheduledAppointments } from "./appointments";
import {
  getActivitiesByDate,
  getGoals,
  getFrequencyTargetProgress,
} from "./training";
import {
  getMedicalRecords,
  getImmunizations,
  getImmunityTiters,
  getImmunizationOverrides,
} from "./medical";
import { hasImportedSmokingHistory } from "./clinical";

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
    const supp = byId.get(dose.supplement_id);
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
      key: `refill:${s.id}`,
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

// The profile's age in MONTHS for the schedule engines: from the birthdate when
// known (exact), else the stored bare-age fallback (× 12), else null (unknown).
// Shared by the immunization and preventive-care assessments so they resolve age
// identically. Profile-scoped reads (getUserBirthdate/getStoredAge filter profile_id).
function profileAgeMonths(profileId: number, today: string): number | null {
  const birthdate = getUserBirthdate(profileId);
  if (birthdate) return ageInMonthsFromBirthdate(birthdate, today);
  const storedAge = getStoredAge(profileId);
  return storedAge != null ? storedAge * 12 : null;
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

// ---- Preventive care (issue #82) ------------------------------------------
// The manual "mark done" SATISFACTION stream for a profile: each row is a rule
// completed on a date, fed straight into the pure assessor. Profile-scoped.
export function getPreventiveSatisfactions(
  profileId: number
): PreventiveSatisfaction[] {
  return db
    .prepare(
      `SELECT rule_key AS ruleKey, date
         FROM preventive_events WHERE profile_id = ?`
    )
    .all(profileId) as PreventiveSatisfaction[];
}

// The manual declined / not-applicable overrides for a profile. Each drops its
// rule out of the actionable set (the pure assessor reads them). Profile-scoped.
export function getPreventiveOverrides(
  profileId: number
): PreventiveOverride[] {
  return db
    .prepare(
      `SELECT rule_key AS ruleKey, kind
         FROM preventive_overrides WHERE profile_id = ?`
    )
    .all(profileId) as PreventiveOverride[];
}

// Record a manual "mark done": rule `ruleKey` satisfied on `date` (a completed
// visit or a screening result). Idempotent on (profile_id, rule_key, date, source)
// so re-confirming the same day is a no-op. `source` is 'manual' for this v1;
// later record-inference writes into the same stream with its own source.
export function recordPreventiveDone(
  profileId: number,
  ruleKey: string,
  date: string,
  source = "manual"
): void {
  db.prepare(
    `INSERT INTO preventive_events (profile_id, rule_key, date, source)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, rule_key, date, source) DO NOTHING`
  ).run(profileId, ruleKey, date, source);
}

// Set a declined / not-applicable override on a preventive rule, upserting on
// (profile_id, rule_key) so re-setting flips the kind (mirrors the immunization
// override writer). Profile-scoped.
export function setPreventiveOverride(
  profileId: number,
  ruleKey: string,
  kind: PreventiveOverrideKind,
  note: string | null = null
): void {
  db.prepare(
    `INSERT INTO preventive_overrides (profile_id, rule_key, kind, note)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, rule_key) DO UPDATE SET
       kind = excluded.kind,
       note = excluded.note,
       created_at = datetime('now')`
  ).run(profileId, ruleKey, kind, note);
}

// Clear any override on a preventive rule so it re-enters the schedule assessment.
// Profile-scoped.
export function clearPreventiveOverride(
  profileId: number,
  ruleKey: string
): void {
  db.prepare(
    "DELETE FROM preventive_overrides WHERE profile_id = ? AND rule_key = ?"
  ).run(profileId, ruleKey);
}

// Preventive well-visits and screenings that are due/overdue for the profile
// (reuses the pure catalog assessor with the same age/sex resolution as the
// immunization schedule). A missing birthdate/age → the assessor emits nothing
// (its contract), so this returns []. Each actionable assessment maps to a
// status-driven `visit`/`screening` Upcoming item carrying its rule key for the
// inline mark-done + override forms.
function preventiveItems(profileId: number, today: string): UpcomingItem[] {
  const summary = assessCatalog({
    ageMonths: profileAgeMonths(profileId, today),
    sex: getUserSex(profileId),
    satisfactions: getPreventiveSatisfactions(profileId),
    overrides: getPreventiveOverrides(profileId),
    // Resolve smoking (issue #83): the structured record wins, else the imported
    // social-history condition is the ever-smoker fallback. Activates the lung
    // LDCT / AAA rules that ship inert.
    smoking: resolveSmoking(
      getSmokingHistory(profileId),
      hasImportedSmokingHistory(profileId)
    ),
    today,
  });
  return summary.actionable.map(preventiveAssessmentToUpcomingItem);
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
function biomarkerItems(profileId: number, today: string): UpcomingItem[] {
  const latest = getMedicalRecords(profileId, { current: true });
  const items: UpcomingItem[] = [];
  for (const r of latest) {
    if (!RETEST_CATEGORIES.has(r.category ?? "")) continue;
    const name = r.canonical_name?.trim() || r.name;
    const retestDays = retestDaysForBiomarker(r.canonical_name?.trim() || null);
    if (!isBiomarkerStale(r.date, r.category, today, retestDays)) continue;
    const interval = retestIntervalDays(retestDays);
    const agoMonths = monthsApprox(daysBetween(r.date, today));
    items.push({
      key: `biomarker:${name.toLowerCase()}`,
      domain: "biomarker",
      title: name,
      detail: `Last tested ${r.date} (${agoMonths}mo ago) · retest every ${monthsApprox(interval)}mo`,
      href: r.canonical_name?.trim()
        ? `/biomarkers/view?name=${encodeURIComponent(name)}`
        : "/biomarkers",
      dueDate: shiftDateStr(r.date, interval),
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
      href: "/appointments",
      dueDate,
    };
  });
}

// Active goals with a target date (reuses getGoals). The deadline drives the
// band, so an overdue deadline reads as Overdue and an approaching one as
// Today/This week/Later.
function goalItems(profileId: number): UpcomingItem[] {
  return getGoals(profileId)
    .filter((g) => !g.archived && g.status === "active" && g.target_date)
    .map((g) => ({
      key: `goal:${g.id}`,
      domain: "goal" as const,
      title: g.title,
      detail: g.category ? `${g.category} goal` : "Goal deadline",
      href: "/goals",
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
      key: `training:${p.target.id}`,
      domain: "training" as const,
      title: frequencyScopeLabel(p.target.scope_kind, p.target.scope_value),
      detail: "Weekly training target",
      href: "/training",
      dueDate: null,
      band: "week" as const,
      dueText: `${p.count}/${p.per_week} this week`,
    }));
}

// Every forward-looking due-signal for the active profile, BEFORE snooze/dismiss
// filtering. `today` is resolved by the caller in the profile's timezone.
function rawUpcoming(profileId: number, today: string): UpcomingItem[] {
  return [
    ...doseItems(profileId, today),
    ...refillItems(profileId, today),
    ...appointmentItems(profileId),
    ...preventiveItems(profileId, today),
    ...immunizationItems(profileId, today),
    ...biomarkerItems(profileId, today),
    ...goalItems(profileId),
    ...trainingItems(profileId),
  ];
}

// The profile's snooze/dismiss rows, keyed by signal_key (a Finding's dedupeKey)
// for O(1) lookup during filtering. This is the shared read behind BOTH the
// Upcoming filter and the generalized findings bus (coaching/digest, issue #39):
// every engine's suppression lives in the one upcoming_dismissals store, so a
// single map answers "is this key suppressed?" for all of them. Profile-scoped
// (the WHERE filters profile_id — enforced by lib/__tests__/profile-scoping.test.ts
// and lib/__db_tests__/upcoming.scoping).
export function getFindingSuppressions(
  profileId: number
): Map<string, SuppressionRecord> {
  const rows = db
    .prepare(
      `SELECT signal_key, snooze_until, dismissed_at
         FROM upcoming_dismissals WHERE profile_id = ?`
    )
    .all(profileId) as {
    signal_key: string;
    snooze_until: string | null;
    dismissed_at: string | null;
  }[];
  const m = new Map<string, SuppressionRecord>();
  for (const r of rows)
    m.set(r.signal_key, {
      snooze_until: r.snooze_until,
      dismissed_at: r.dismissed_at,
    });
  return m;
}

// ---- Generalized suppression writers (issue #39) ----
// The table-usage side of the findings bus: the Upcoming actions AND the coaching/
// digest dismiss affordances all funnel through these, so there's one upsert/delete
// on upcoming_dismissals rather than a copy per surface. Each is profile-scoped and
// keyed by an arbitrary Finding dedupeKey (existing Upcoming keys unchanged).

// Snooze a finding until `until` (YYYY-MM-DD), clearing any dismiss — upserts on
// the (profile_id, signal_key) unique index so re-snoozing just moves the date.
export function snoozeFinding(
  profileId: number,
  dedupeKey: string,
  until: string
): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, ?, NULL)
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET snooze_until = excluded.snooze_until, dismissed_at = NULL`
  ).run(profileId, dedupeKey, until);
}

// Dismiss a finding indefinitely (until restored), clearing any snooze so a
// dismiss always wins.
export function dismissFinding(profileId: number, dedupeKey: string): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (?, ?, NULL, datetime('now'))
     ON CONFLICT(profile_id, signal_key)
       DO UPDATE SET dismissed_at = datetime('now'), snooze_until = NULL`
  ).run(profileId, dedupeKey);
}

// Restore a finding: drop its suppression row so it reappears immediately.
export function restoreFinding(profileId: number, dedupeKey: string): void {
  db.prepare(
    "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
  ).run(profileId, dedupeKey);
}

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
