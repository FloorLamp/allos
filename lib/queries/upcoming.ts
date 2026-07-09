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
} from "../settings";
import type { UpcomingItem } from "../upcoming";
import { getSupplements, getSupplementDoses, getTakenDoseIds } from "./intake";
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
// doses/day ≈ the number of scheduled dose rows, matching the refill notifier).
// The estimated run-out date (today + days-left) drives the band, so an item with
// 0 days left lands in Today and a week of runway lands in This week.
function refillItems(profileId: number, today: string): UpcomingItem[] {
  const tracked = getSupplements(profileId).filter(
    (s) => s.active && s.quantity_on_hand != null
  );
  if (tracked.length === 0) return [];
  const doseCount = new Map<number, number>();
  for (const d of getSupplementDoses(profileId))
    doseCount.set(d.supplement_id, (doseCount.get(d.supplement_id) ?? 0) + 1);

  const items: UpcomingItem[] = [];
  for (const s of tracked) {
    const daysLeft = daysOfSupplyLeft(
      s.quantity_on_hand,
      s.qty_per_dose,
      doseCount.get(s.id) ?? 0
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

// Vaccines due/overdue on the tracked schedule (reuses assessSchedule + the same
// age/sex resolution the immunizations page uses). Status-driven, so each item
// carries an explicit band + due-text rather than a calendar date.
function immunizationItems(profileId: number, today: string): UpcomingItem[] {
  const birthdate = getUserBirthdate(profileId);
  const sex = getUserSex(profileId);
  const storedAge = birthdate ? null : getStoredAge(profileId);
  const ageMonths = birthdate
    ? ageInMonthsFromBirthdate(birthdate, today)
    : storedAge != null
      ? storedAge * 12
      : null;

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
    ...immunizationItems(profileId, today),
    ...biomarkerItems(profileId, today),
    ...goalItems(profileId),
    ...trainingItems(profileId),
  ];
}

// The profile's snooze/dismiss rows, keyed by signal_key for O(1) lookup during
// filtering. Profile-scoped (the WHERE filters profile_id — enforced by
// lib/__tests__/profile-scoping.test.ts and lib/__db_tests__/upcoming.scoping).
function suppressionMap(profileId: number): Map<string, SuppressionRecord> {
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
  const map = suppressionMap(profileId);
  return rawUpcoming(profileId, today).filter(
    (item) => !isItemSuppressed(map, item, today)
  );
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
  const map = suppressionMap(profileId);
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
