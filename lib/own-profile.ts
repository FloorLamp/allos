// Own-profile / self-vs-other — the ONE pure predicate the not-self write
// affordances share (issue #1013). Self is defined by the login's own-profile
// association (lib/scope.ts `ownProfileId`, migration 103); this module turns that
// datum into the labels and booleans every surface reads, so "is this write going to
// ME?" is one computation, not a per-surface re-derivation (#221/#534).
//
// The rule, stated once:
//   • A login with NO own-profile (ownProfileId === null — e.g. a caregiver-only
//     login, or a login that hasn't set one) has no defined self, so the self/other
//     distinction is OFF: nothing is named as "not you" (the plain #1096
//     disambiguation still names cross-profile items — this layer only adds the
//     self emphasis).
//   • A login WITH an own-profile names the subject on any write whose EFFECTIVE
//     TARGET is not that profile — a household card confirming a dose for someone
//     else, a form logging to a switched-in other profile, the live workout editor
//     when the acting profile isn't the login's own.
//
// Pure (no DB, no React) so the whole matrix is unit-tested without a request.

// Is `profileId` the login's own profile? Null-safe: a login with no own-profile is
// never "self". This is the atom the acting-profile predicate and the per-target
// naming both build on.
export function isOwnProfile(
  ownProfileId: number | null,
  profileId: number
): boolean {
  return ownProfileId !== null && ownProfileId === profileId;
}

// The self predicate on the ACTING profile — `scope.actingProfileId ===
// scope.ownProfileId`, null-safe (issue #1013's shared fact). True when the login is
// currently acting AS its own profile; false when acting as someone else's or when
// no own-profile is set. Consumed by the banner's not-self states (#1096) and any
// acting-profile write affordance.
export function isViewingSelf(scope: {
  actingProfileId: number;
  ownProfileId: number | null;
}): boolean {
  return isOwnProfile(scope.ownProfileId, scope.actingProfileId);
}

// The subject NAME to stamp on a write affordance whose target is `targetProfileId`,
// or null when no name should be shown. Null in exactly two cases: the login has no
// defined self (ownProfileId null — the distinction is off), or the target IS the
// login's own profile (self needs no naming). Otherwise the target's disambiguated
// name (#534), so the affordance reads "…not you, this is <name>".
export function writeSubjectName(
  ownProfileId: number | null,
  targetProfileId: number,
  name: string
): string | null {
  if (ownProfileId === null) return null;
  if (targetProfileId === ownProfileId) return null;
  return name;
}

// Compose a not-self write label. When `subjectName` is null (self, or no defined
// self) the base label is returned unchanged; otherwise the subject is appended as
// "<base> — <name>" ("Log dose — Mia", "Log set — Mia"). One formatter, so every
// surface renders the naming identically.
export function subjectActionLabel(
  base: string,
  subjectName: string | null
): string {
  return subjectName ? `${base} — ${subjectName}` : base;
}
