// HOW MANY OTHER HOUSEHOLD MEMBERS THE DASHBOARD DOES PER-PROFILE WORK FOR.
//
// The dashboard renders FOUR cross-profile surfaces: the household strip (an
// attention-count chip per member), the illness accordion (an open-episode line
// per sick member), the recently-resolved reopen band, and the household-history
// promo's recently-sick predicate. All four fan out over `accessible` — the
// profiles the session may act as — and each does a genuinely expensive read per
// profile: attentionCountForProfile runs the whole attention model (suppressions,
// risk factors, flagged biomarkers, the Upcoming pipeline, integrations, review
// counts), and the three illness surfaces read that member's episode rows (ONE
// shared gather since #2115, but still one gather per member).
//
// For a household that is fine — a family is a handful of people. But an ADMIN
// reaches EVERY profile on the instance (lib/auth.ts accessibleProfiles), so the
// per-member cost is multiplied by the whole instance rather than by one family.
// Measured on the e2e template (180 profiles): the fan-out alone was ~1.69s of
// the dashboard's ~1.56s server render — about 90% of it — and it emitted 1.5MB
// of HTML, growing by ~9ms for every profile ever added. A caregiver-heavy real
// instance hits the same wall.
//
// So the work is BOUNDED rather than left to scale with the instance. The bound
// is deliberately well above a real household: twelve other members covers
// multi-generational families and their carers with room to spare, while capping
// the dashboard's cross-profile cost at roughly a tenth of a second.
//
// WHAT A LARGER SET SEES: the first twelve by profile id, which is the order
// accessibleProfiles already returns (ORDER BY p.id) and therefore stable
// between renders. Members past the bound are absent from these four surfaces
// only — every profile remains reachable through the switcher, and its own
// dashboard is unaffected. This is a display bound on a summary strip, not an
// access rule, and it must never be used as one.
export const HOUSEHOLD_FANOUT_LIMIT = 12;

// The other members this render will do per-profile work for: everyone the
// session can act as, minus the acting profile, bounded. Pure and id-ordered, so
// two renders of the same session agree on the set.
export function householdFanoutProfiles<T extends { id: number }>(
  accessible: readonly T[],
  actingProfileId: number,
  limit: number = HOUSEHOLD_FANOUT_LIMIT
): T[] {
  return accessible
    .filter((p) => p.id !== actingProfileId)
    .slice(0, Math.max(0, limit));
}

// The same bound for a surface that is ABOUT THE VIEWER TOO (issue #2446): the
// reopen band's most useful line is the viewer's own just-resolved episode, and
// the recently-sick promo counts the viewer's own illness. So the acting profile
// is always included and the bound applies to the OTHERS — `householdFanoutProfiles`
// with the viewer added back.
//
// Returned in `accessible`'s own order (not viewer-first) so the reopen band's
// line order is exactly what it was before the bound landed; the set is
// {acting} ∪ the first `limit` others by id, which is stable between renders for
// the same reason the base bound is.
export function householdFanoutWithActing<T extends { id: number }>(
  accessible: readonly T[],
  actingProfileId: number,
  limit: number = HOUSEHOLD_FANOUT_LIMIT
): T[] {
  const others = new Set(
    householdFanoutProfiles(accessible, actingProfileId, limit).map((p) => p.id)
  );
  return accessible.filter((p) => p.id === actingProfileId || others.has(p.id));
}
