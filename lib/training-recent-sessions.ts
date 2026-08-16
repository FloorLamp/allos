import type { ActivityType } from "./types";
import type { DayGroup, DisplayPart } from "./training-log-card";
import { activityComponentSportNames } from "./activity-icon";
import { activityDetailHref } from "./ride-detail";
import type { AppRoute } from "./hrefs";

// WHAT YOU DID (#2566) — the Training Overview's missing half.
//
// Overview answered "what should I do next" (today's session, the routine's
// remaining cadence) and "what shape did the week have" (the spine's colored
// blocks), but nowhere on it could you read what you ACTUALLY did. A block is a
// block: it does not say the run was 8 km or that the squat day worked up to
// 100 kg. That reading needed the Log tab, which is a different surface with a
// different job.
//
// This is a pure fold over the Training Log's OWN cards (buildTrainingLogFeedPage
// → DayGroup[]) — the same derivation the Log renders, never a second one, so a
// session cannot read one way here and another way there (#221). All this module
// decides is WHICH sessions belong on the overview and how much of each fits.
//
// The window is the week spine's own window, so the picture and the list are the
// same week. A future-dated activity is a plan, not a thing you did, so it is
// excluded even though it sits at the top of the Log's newest page. When the week
// holds nothing at all, the single most recent session stands in — "nothing this
// week" is a true statement about the week and a useless answer to "what did I
// last do".

// How many sessions the overview shows before handing off to the Log. Four is
// the honest cap for a summary; the count of what is not shown is stated, never
// silently dropped.
export const RECENT_SESSION_LIMIT = 4;
// Lines within one session. A ten-exercise day is a Log-tab read; here it shows
// its first few and says how many more there are.
export const RECENT_SESSION_PART_LIMIT = 5;

export interface RecentSessionRow {
  id: number;
  title: string;
  type: ActivityType;
  // Structured component/sport names, so an imported ride icons as a bike
  // exactly as it does on its Log card.
  sportNames: string[];
  // The day group's own label ("Today" / "Yesterday" / a long date) — the Log's
  // wording, not a second date vocabulary.
  dayLabel: string;
  // Clock time, duration, distance, speed, heart rate, calories — whichever the
  // card resolved, in the card's own reading order.
  meta: string[];
  parts: DisplayPart[];
  // Parts beyond the cap, stated rather than dropped.
  moreParts: number;
  href: AppRoute;
}

export interface RecentSessionsView {
  rows: RecentSessionRow[];
  // "week": these sessions sit inside the spine's window. "earlier": the week is
  // empty and this is the one most recent session, whenever it was.
  scope: "week" | "earlier";
  // In-window sessions past RECENT_SESSION_LIMIT (always 0 when scope is
  // "earlier" — the fallback shows exactly one).
  more: number;
}

export const EMPTY_RECENT_SESSIONS: RecentSessionsView = {
  rows: [],
  scope: "week",
  more: 0,
};

export function recentSessionsView(
  groups: DayGroup[],
  window: { weekStart: string; today: string }
): RecentSessionsView {
  // The feed is already newest-first (date DESC, id DESC within a day), so the
  // flattened order IS "most recent session first" and nothing re-sorts.
  const dated = groups.flatMap((g) =>
    g.cards.map((card) => ({ date: g.date, label: g.label, card }))
  );
  // Tomorrow's planned run is not something you did.
  const done = dated.filter((d) => d.date <= window.today);
  const thisWeek = done.filter((d) => d.date >= window.weekStart);

  if (thisWeek.length === 0) {
    const last = done[0];
    return {
      rows: last ? [toRow(last)] : [],
      scope: "earlier",
      more: 0,
    };
  }
  return {
    rows: thisWeek.slice(0, RECENT_SESSION_LIMIT).map(toRow),
    scope: "week",
    more: Math.max(0, thisWeek.length - RECENT_SESSION_LIMIT),
  };
}

function toRow(entry: {
  label: string;
  card: DayGroup["cards"][number];
}): RecentSessionRow {
  const { card } = entry;
  const meta = [
    card.timeText,
    card.durationText,
    card.distanceText,
    card.speedText,
    card.heartRateText,
    card.calorieText,
  ].filter((v): v is string => Boolean(v));
  return {
    id: card.activity.id,
    title: card.activity.title,
    type: card.activity.type,
    sportNames: activityComponentSportNames(card.activity.components),
    dayLabel: entry.label,
    meta,
    parts: card.parts.slice(0, RECENT_SESSION_PART_LIMIT),
    moreParts: Math.max(0, card.parts.length - RECENT_SESSION_PART_LIMIT),
    // The SAME resolver every other surface uses (#2870), so a session opens the
    // one destination it has — a ride its performance detail, everything else its
    // canonical page.
    href: activityDetailHref(card.activity),
  };
}

// The one line of a part, in the same reading order the Log card uses: name,
// then its compact description.
export function recentSessionPartText(part: DisplayPart): string {
  return part.kind === "strength" ? part.text : part.detail;
}
