// HOW MANY OTHER HOUSEHOLD MEMBERS THE DASHBOARD DOES PER-PROFILE WORK FOR.
//
// The dashboard renders two cross-profile surfaces: the household strip (an
// attention-count chip per member) and the illness accordion (an open-episode
// line per sick member). Both fan out over `accessible` — the profiles the
// session may act as — and both do a genuinely expensive read per profile:
// attentionCountForProfile runs the whole attention model (suppressions, risk
// factors, flagged biomarkers, the Upcoming pipeline, integrations, review
// counts), and currentEpisodeForProfile assembles an episode.
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
// between renders. Members past the bound are absent from these two surfaces
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
