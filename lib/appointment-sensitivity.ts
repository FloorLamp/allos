import type { AppointmentKind } from "./types";

// Sensitivity-aware detail for appointments on SHARED / exported surfaces (issue
// #997). PURE — no DB/network, client-safe, unit-tested in
// lib/__tests__/appointment-sensitivity.test.ts.
//
// Most appointment kinds show whatever detail the shared surface is set to — the
// household strip and the .ics family calendar feed already carry a minimal/full
// PHI toggle (lib/settings/calendar-feed.ts). A MENTAL-HEALTH visit is different:
// "Psychiatry — Dr X" must not leak into a household strip or an exported family
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
