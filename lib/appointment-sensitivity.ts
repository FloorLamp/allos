import type { AppointmentKind } from "./types";
import type { RecentChangeCategory } from "./recent-changes";

// WHAT A SHARED SURFACE MAY SHOW (issue #997, widened by #1463). PURE — no DB/network,
// client-safe, unit-tested in lib/__tests__/appointment-sensitivity.test.ts.
//
// Two rules live here, and they live TOGETHER on purpose: "this surface is shared"
// must mean ONE thing wherever it is declared, decided once, or the next consumer to
// pass the flag inherits nothing and reproduces the disclosure one surface later.
//
//   1. APPOINTMENT DETAIL — a behavioral-health visit is stated minimally (below).
//   2. WITHHELD CATEGORIES — a mood check-in is not shown at all (bottom of file).
//
// Most appointment kinds show whatever detail the shared surface is set to — the
// household rollups and the .ics family calendar feed already carry a minimal/full
// PHI toggle (lib/settings/calendar-feed.ts). A MENTAL-HEALTH visit is different:
// "Psychiatry — Dr X" must not leak into a household rollup or an exported family
// calendar by default, even when other kinds show full detail. So a mental_health
// visit DEFAULTS to minimal ("Medical appointment") on any shared surface — the one
// kind where the default flips toward privacy — and the profile OWNER can override
// that back to full if they want it visible.
//
// This is the ONE decision every shared surface consults (#221 "one question, one
// computation"): the household rollup (lib/queries/upcoming/generators.ts) and the
// calendar-feed builder (lib/calendar-ics.ts) both call `sharedSurfaceDetail` rather
// than each re-deciding which kinds are sensitive. A profile's OWN surfaces (its
// Upcoming page, Timeline, the appointment form) NEVER call this — they always show
// full detail, so this module can't accidentally hide a visit from its owner.

export type SharedDetail = "minimal" | "full";

// The appointment kinds whose default detail flips toward privacy on shared /
// exported surfaces (#997). Behavioral-health is the single behavioral-health-
// specific privacy rule; kept as a set so a future sensitive kind joins here.
const PRIVACY_DEFAULT_KINDS = new Set<AppointmentKind>(["mental_health"]);

// Whether a kind defaults to MINIMAL detail on shared surfaces (before the owner's
// override is applied). A null/unknown kind is never sensitive.
export function kindDefaultsToMinimalShared(
  kind: AppointmentKind | null | undefined
): boolean {
  return kind != null && PRIVACY_DEFAULT_KINDS.has(kind);
}

// The detail level that actually applies to an appointment of `kind` on a SHARED
// surface whose requested detail is `requested`. A privacy-default kind forces
// `minimal` UNLESS the profile owner opted it back into full shared detail
// (`sensitiveShareFull`); every other kind honors `requested` unchanged. Never
// UP-levels: it can only push a requested "full" down to "minimal", never reveal
// more than the surface asked for.
export function sharedSurfaceDetail(
  kind: AppointmentKind | null | undefined,
  requested: SharedDetail,
  opts: { sensitiveShareFull?: boolean } = {}
): SharedDetail {
  if (kindDefaultsToMinimalShared(kind) && !opts.sensitiveShareFull) {
    return "minimal";
  }
  return requested;
}

// ── Rule 2: categories a shared surface withholds ENTIRELY (#1463, owner ruling
// 2026-09-01) ────────────────────────────────────────────────────────────────────
//
// A MINIMAL RESTATEMENT IS THE WRONG TOOL FOR A MOOD SCORE. Rule 1 works for a visit
// because "Medical appointment" is still a true, useful thing to say — the caregiver
// learns there is an appointment and learns nothing about why. A daily check-in has no
// such residue: "mood 2/5" masked down to "a check-in happened" reports nothing worth a
// line, and reporting the score reports the whole of it. So the answer is absence.
//
// AND IT IS A DIFFERENT KIND OF FACT. The other categories a shared digest carries —
// flagged labs, out-of-range vitals, symptom days — are what a caregiver is granted
// access in order to ACT on, and withholding them would leave nothing worth rendering.
// A mood check-in is a subjective daily self-report: access granted to help with
// somebody's medications is not access to their mood feed.
//
// The profile's OWN surfaces never consult this (its digest passes `shared: false`), so
// a check-in is never hidden from the person who wrote it.
const SHARED_SURFACE_WITHHELD_CATEGORIES = new Set<RecentChangeCategory>([
  "mood",
]);

// Whether a shared surface withholds this whole category. Consulted ONCE, over the
// collected set, by `collectRecentChanges` — never per-category at a call site, so a
// category added tomorrow is judged by this rule rather than by whoever adds it.
export function sharedSurfaceWithholdsCategory(
  category: RecentChangeCategory
): boolean {
  return SHARED_SURFACE_WITHHELD_CATEGORIES.has(category);
}
