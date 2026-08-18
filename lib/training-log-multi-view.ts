// Pure multi-view merge + per-member gating for the Training Log (issue #1330).
// The Tier-2 adoption: the Training Log's day-grouped card feed rendered across the whole
// view-set, with each card re-keyed to the profile it came from. Everything here is
// PURE (no DB, no JSX) — the DB gather (buildMultiViewTrainingLogGroups in
// lib/training-log-feed.ts) loops the per-profile buildTrainingLogFeedPage and hands the
// per-member DayGroups to mergeTrainingLogDayGroups; the server component then stamps
// subject identity (name/photo/access) via lib/scope's stampSubjects.
//
// WHY loop-composed, not a set-based `profile_id IN` read: each member's feed is
// built with that member's OWN today/yesterday day labels and per-profile route/
// video/equipment gathers (the #1096 per-profile-context rule). We merge the
// already-built groups here and RE-LABEL by the viewer's (acting) clock so one date
// reads one way in the merged feed — a member's week/day is never evaluated in
// another member's context (the lib/attention.ts loop-composed precedent).

import type { DayGroup, TrainingLogCardData } from "./training-log-card";

// One member's already-built Training Log feed groups (buildTrainingLogFeedPage), tagged with
// the profile they belong to. View order is preserved by the caller (scope.viewIds).
export interface MemberTrainingLogGroups {
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
export function mergeTrainingLogDayGroups(
  members: readonly MemberTrainingLogGroups[],
  relabel: (date: string) => string
): DayGroup[] {
  // date -> (member view index -> that member's cards for the date), so we can emit
  // members in view order within each day without re-scanning.
  const dates: string[] = [];
  const seenDate = new Set<string>();
  // date -> ordered list of { order, cards }
  const byDate = new Map<
    string,
    { order: number; cards: TrainingLogCardData[] }[]
  >();

  members.forEach((member, order) => {
    for (const g of member.groups) {
      if (!seenDate.has(g.date)) {
        seenDate.add(g.date);
        dates.push(g.date);
      }
      // Stamp each card's subject so the write layer can target it; clone so the
      // per-member source group is never mutated.
      const stamped = g.cards.map((c): TrainingLogCardData => ({
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

// Detail drill-ins use the acting profile's loaded analytics, so a non-acting
// subject's names stay non-interactive. Life stage does not hide activity history.
export function trainingLogDrillInsVisible(isActing: boolean): boolean {
  return isActing;
}
