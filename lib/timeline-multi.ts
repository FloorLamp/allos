// Multi-view Timeline merge + per-member LOCAL-day bucketing (issue #1329). PURE (no
// DB, no JSX), so the divergent-day decision is unit-tested in isolation and the page
// is a formatter over its result.
//
// The genuinely new decision here — the one #1096 flagged as Timeline's real work — is
// DAY BUCKETING ACROSS TIMEZONES. "Tuesday" is not one boundary: each member's items
// land on THEIR OWN local calendar date (already computed per member in that member's
// timezone by the per-profile gather — the per-profile-context trap #1096 forbids
// computing Mia's "today" in Sam's clock), and when members' current dates DIVERGE
// (travel, midnight straddle) the day header must carry the divergence honestly rather
// than pretending one calendar. A calendar-date HEADER (e.g. "July 14") is already
// unambiguous; the divergence that isn't is the RELATIVE meaning — the same absolute
// date is one member's "today" and another's "tomorrow". So a day carries per-member
// relative marks ONLY when that relative meaning diverges across the in-view members.
//
// This mirrors lib/attention.ts's MemberAttention/mergeAttentionPageGroups precedent:
// band/bucket EACH member in that member's OWN today, then merge same-date groups. A
// single-member call (single view) never diverges, so it emits no marks and the page
// renders byte-identical to today.

import { shiftDateStr } from "./date";
import type { TimelineEvent } from "./timeline-format";

// A timeline event tagged with the profile it belongs to, so a merged day can render
// its subject chip (#534) and its day-deep-link can re-key to the item's own profile.
export type ProfiledTimelineEvent = TimelineEvent & { profileId: number };

// One member's already-gathered timeline events, plus THAT member's own "today" (its
// timezone-local date). The date is carried per member on purpose — it is the
// per-profile-context trap (#1096): a member's relative-day labelling MUST be computed
// against its OWN today, never a shared one. Each event's `date` is likewise already
// the member's local calendar date (the per-profile gather resolved created-at
// fallbacks in the member's timezone).
export interface MemberTimeline {
  profileId: number;
  today: string;
  events: ProfiledTimelineEvent[];
}

// The near-today relative meaning of a calendar date for one member. Only these three
// (± one day of the member's today) are surfaced — beyond that the absolute date header
// is unambiguous on its own, so there's nothing to disambiguate.
export type RelativeDay = "today" | "yesterday" | "tomorrow";

// One member's relative-day meaning for a divergent day (rendered as an on-element
// badge naming WHOSE relative day it is — never a spatial cue, #531).
export interface DayMark {
  profileId: number;
  relative: RelativeDay;
}

// A merged day-group across the view-set: the calendar date, every in-view member's
// items for THAT date (sorted), and — ONLY when the date's relative meaning diverges
// across members — per-member relative marks (the honest divergent-day header). `marks`
// is empty for an ordinary day and ALWAYS empty in single view, so the page adds no
// divergence chrome unless it's genuinely earned.
export interface MergedTimelineDay {
  date: string;
  events: ProfiledTimelineEvent[];
  marks: DayMark[];
}

// The near-today relative label of `date` in a member's frame, or null when `date` is
// more than a day from that member's today (far past/future — the absolute header says
// it all).
export function relativeDay(
  date: string,
  memberToday: string
): RelativeDay | null {
  if (date === memberToday) return "today";
  if (date === shiftDateStr(memberToday, -1)) return "yesterday";
  if (date === shiftDateStr(memberToday, 1)) return "tomorrow";
  return null;
}

// Newest-first ordering for merged cross-profile events. Same shape as
// sortTimelineEvents (date desc, then sortTime desc), with a profileId tiebreak BEFORE
// the id compare so two members' rows that happen to share an event id (e.g. both have
// activity id 5) still order deterministically and never collide as a React key.
function compareMerged(
  a: ProfiledTimelineEvent,
  b: ProfiledTimelineEvent
): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const at = a.sortTime ?? "";
  const bt = b.sortTime ?? "";
  if (at !== bt) return at < bt ? 1 : -1;
  if (a.profileId !== b.profileId) return a.profileId - b.profileId;
  return a.id.localeCompare(b.id);
}

// Compute the per-member relative marks for a calendar date, or [] when the date is NOT
// divergent. A date is divergent when its relative meaning is NOT uniform across the
// in-view members — i.e. it's "today" (or yesterday/tomorrow) for at least one member
// while meaning something ELSE (a different near label, or far-off entirely) to
// another. A single member can never diverge (one meaning), so single view emits []. A
// date all members agree on (same relative label, or far-off for everyone) also emits
// [] — no false divergence chrome for aligned timezones or old history.
export function dayMarksFor(
  date: string,
  members: readonly MemberTimeline[]
): DayMark[] {
  const rels = members.map((m) => relativeDay(date, m.today));
  const distinct = new Set(rels.map((r) => r ?? "far"));
  const hasNear = rels.some((r) => r !== null);
  // Divergent iff members disagree on what this date means AND at least one holds it
  // in the near-today window (a purely far-off-for-everyone date isn't interesting).
  if (distinct.size <= 1 || !hasNear) return [];
  const marks: DayMark[] = [];
  members.forEach((m, i) => {
    const rel = rels[i];
    if (rel !== null) marks.push({ profileId: m.profileId, relative: rel });
  });
  return marks;
}

// Merge several members' timeline events into ONE newest-first list of day-groups,
// bucketing each event by ITS OWN member-local calendar date (the trap) and annotating
// each day with the honest divergent-day marks. The result is the multi-view analogue
// of groupTimelineDays — one grouping engine whether one member or five (#221). Days
// are newest-first; a day's events are sorted with the cross-profile comparator.
export function mergeMemberTimelines(
  members: readonly MemberTimeline[]
): MergedTimelineDay[] {
  const byDate = new Map<string, ProfiledTimelineEvent[]>();
  for (const member of members) {
    for (const event of member.events) {
      const arr = byDate.get(event.date);
      if (arr) arr.push(event);
      else byDate.set(event.date, [event]);
    }
  }
  const dates = Array.from(byDate.keys()).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0
  );
  return dates.map((date) => ({
    date,
    events: byDate.get(date)!.sort(compareMerged),
    marks: dayMarksFor(date, members),
  }));
}

// One member's own day-grouped timeline for the BY-PERSON view mode (issue #1327 fix 2
// / #1329): the member's events grouped by their own local dates, newest-first. The
// alternative presentation to mergeMemberTimelines over the SAME per-member gather — the
// mode lives here so the shared merge layer owns both orderings, never a per-page fork.
export interface MemberTimelineSection {
  profileId: number;
  today: string;
  days: MergedTimelineDay[];
  empty: boolean;
}

export function byPersonTimelines(
  members: readonly MemberTimeline[]
): MemberTimelineSection[] {
  return members.map((m) => ({
    profileId: m.profileId,
    today: m.today,
    // A single member never diverges, so its per-member day headers carry no marks —
    // the section header already names whose timeline it is.
    days: mergeMemberTimelines([m]),
    empty: m.events.length === 0,
  }));
}
