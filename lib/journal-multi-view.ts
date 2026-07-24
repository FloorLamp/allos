// Pure multi-view merge + per-member gating for the Training Journal (issue #1330).
// The Tier-2 adoption: the Journal's day-grouped card feed rendered across the whole
// view-set, with each card re-keyed to the profile it came from. Everything here is
// PURE (no DB, no JSX) — the DB gather (buildMultiViewJournalGroups in
// lib/journal-feed.ts) loops the per-profile buildJournalFeedPage and hands the
// per-member DayGroups to mergeJournalDayGroups; the server component then stamps
// subject identity (name/photo/access) via lib/scope's stampSubjects.
//
// WHY loop-composed, not a set-based `profile_id IN` read: each member's feed is
// built with that member's OWN today/yesterday day labels and per-profile route/
// video/equipment gathers (the #1096 per-profile-context rule). We merge the
// already-built groups here and RE-LABEL by the viewer's (acting) clock so one date
// reads one way in the merged feed — a member's week/day is never evaluated in
// another member's context (the lib/attention.ts loop-composed precedent).

import type { DayGroup, JournalCardData } from "./journal-card";

// One member's already-built Journal feed groups (buildJournalFeedPage), tagged with
// the profile they belong to. View order is preserved by the caller (scope.viewIds).
export interface MemberJournalGroups {
  profileId: number;
  groups: DayGroup[];
}

// Merge each member's day-grouped cards into ONE feed, newest day first, with each
// card STAMPED with its subject profile (activity.subjectProfileId) so a per-card
// edit/delete/merge targets the row's own profile (gateItemProfile). Within a single
// day the members are concatenated in view order, each keeping its own within-day
// order — a stable, deterministic interleave. Every merged group's label is
// RE-DERIVED from `relabel(date)` (the viewer's today/yesterday clock), NOT inherited
// from any one member's per-profile label, so two members whose "today" differ by
// timezone can't make one date carry two labels. Pure: same inputs → same output.
export function mergeJournalDayGroups(
  members: readonly MemberJournalGroups[],
  relabel: (date: string) => string
): DayGroup[] {
  // date -> (member view index -> that member's cards for the date), so we can emit
  // members in view order within each day without re-scanning.
  const dates: string[] = [];
  const seenDate = new Set<string>();
  // date -> ordered list of { order, cards }
  const byDate = new Map<
    string,
    { order: number; cards: JournalCardData[] }[]
  >();

  members.forEach((member, order) => {
    for (const g of member.groups) {
      if (!seenDate.has(g.date)) {
        seenDate.add(g.date);
        dates.push(g.date);
      }
      // Stamp each card's subject so the write layer can target it; clone so the
      // per-member source group is never mutated.
      const stamped = g.cards.map((c): JournalCardData => ({
        ...c,
        activity: { ...c.activity, subjectProfileId: member.profileId },
      }));
      const bucket = byDate.get(g.date) ?? [];
      bucket.push({ order, cards: stamped });
      byDate.set(g.date, bucket);
    }
  });

  // Newest day first (string dates sort chronologically), matching single view.
  dates.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  return dates.map((date) => {
    const buckets = (byDate.get(date) ?? [])
      .slice()
      .sort((a, b) => a.order - b.order);
    return {
      date,
      label: relabel(date),
      cards: buckets.flatMap((b) => b.cards),
    };
  });
}

// Per-member fitness-surface gate (issue #1330, #489). A card's adult fitness
// affordances — the exercise/cardio/sport detail drill-ins (e1RM/standards/trends) —
// render only for the ACTING profile's own, un-restricted cards: a caregiver viewing
// a child's cards is NOT the child's restricted session, but the child's own age gate
// still governs whether those adult surfaces appear on the child's cards, and the
// analytics loaded are the ACTING profile's (its own detail panel), so a non-acting
// subject's names stay non-interactive. Pure — the view layer and any test agree on
// the one rule.
export function journalFitnessSurfacesVisible(ctx: {
  isActing: boolean;
  subjectRestricted: boolean;
}): boolean {
  return ctx.isActing && !ctx.subjectRestricted;
}
