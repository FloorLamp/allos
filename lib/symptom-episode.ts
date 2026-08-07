// Derived illness-episode association (issue #799). A symptom row is NOT stored with a
// foreign key to an episode — an "episode" is DERIVED from the situation change-log
// (#654): the maximal window during which an ILLNESS-TYPE situation (#799's illness_type
// flag) was continuously active. `episodeForDate` is the ONE pure computation the
// dashboard symptom card and the future episode view (#800) both key on, so a symptom's
// episode can never disagree across surfaces. No side-state to maintain on episode edits.
//
// Pure list math over the same `SituationEvent[]` change-log `situationsActiveOn` reads
// (lib/trend-annotations.ts). Reconstruction semantics MATCH that function: an episode
// covers [start, end] — inclusive first active day, inclusive LAST active day (#2232;
// a stop event on day D means the situation was active through D−1, so the derived
// `end` is the stop date minus one). A null start means active since before the
// (capped) log began; a null end means ongoing. That [start, end] window is the
// chassis's inclusive-end convention (lib/date-range.ts, issue #943): these functions
// CONSTRUCT a range around `date` from the change-log rather than testing membership,
// so they don't call rangeContainsDate, but the end-bound they build is the one the
// chassis declares.

import { shiftDateStr } from "./date";
import type { SituationEvent } from "./trend-annotations";

export interface IllnessEpisode {
  // The stored episode row id (#856), when this episode came from illness_episodes —
  // used to link to /medical/episodes/[id]. Undefined for the pure change-log
  // derivations below (they predate the row), which stay id-less.
  id?: number;
  // The illness-type situation this episode belongs to (its name).
  situation: string;
  // Inclusive first active day (YYYY-MM-DD), or null = active before the log began.
  start: string | null;
  // Inclusive LAST active day (YYYY-MM-DD, #2232 — the stored `end_date` carries the
  // same value), or null = ongoing.
  end: string | null;
}

// The minimal per-situation state the derivation needs: its name and whether it is
// CURRENTLY active (the authoritative seed the change-log is replayed against). Callers
// pass ONLY illness-type-flagged situations, so Travel/High-stress never form episodes.
export interface IllnessSituationState {
  name: string;
  active: boolean;
}

const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

// This situation's events, well-formed, sorted by date then start-before-stop so a
// same-day toggle opens then closes deterministically.
function eventsFor(
  name: string,
  events: readonly SituationEvent[]
): SituationEvent[] {
  const key = name.trim();
  return events
    .filter((e) => e.situation.trim() === key && isDate(e.date))
    .slice()
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.change === b.change ? 0 : a.change === "start" ? -1 : 1)
    );
}

// The episode of ONE situation that contains `date`, or null when the situation was not
// active on `date`. Local per-date reasoning identical to situationsActiveOn: the state
// on `date` is decided by the earliest transition strictly AFTER it (a future "stop" ⇒
// active on `date`; a future "start" ⇒ inactive), falling back to the current state when
// there is none. The episode's inclusive end is the day before the earliest stop after
// `date`; its inclusive start is the latest start on-or-before it (null = active before
// the log).
export function episodeContainingDate(
  date: string,
  name: string,
  events: readonly SituationEvent[],
  currentlyActive: boolean
): IllnessEpisode | null {
  if (!isDate(date)) return null;
  const ev = eventsFor(name, events);
  const after = ev.find((e) => e.date > date);
  const active = after ? after.change === "stop" : currentlyActive;
  if (!active) return null;
  const stop =
    ev.find((e) => e.date > date && e.change === "stop")?.date ?? null;
  const end = stop == null ? null : shiftDateStr(stop, -1);
  let start: string | null = null;
  for (const e of ev)
    if (e.date <= date && e.change === "start") start = e.date;
  return { situation: name, start, end };
}

// Associate a symptom's `date` with an illness episode, or null. Considers only the
// illness-type situations passed in (the flag gate lives at the caller). When several
// flagged situations were active on the day, the most-recently-started one wins (the
// tightest containing episode), breaking ties by situation name for determinism.
export function episodeForDate(
  date: string,
  illnessSituations: readonly IllnessSituationState[],
  events: readonly SituationEvent[]
): IllnessEpisode | null {
  const hits: IllnessEpisode[] = [];
  for (const s of illnessSituations) {
    const ep = episodeContainingDate(date, s.name, events, s.active);
    if (ep) hits.push(ep);
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    // A known start outranks a null (before-log) start; then latest start wins.
    if (a.start !== b.start) {
      if (a.start === null) return 1;
      if (b.start === null) return -1;
      return b.start.localeCompare(a.start);
    }
    return a.situation.localeCompare(b.situation);
  });
  return hits[0];
}

// One historical on→off run of a situation, as the change-log states it: `start` is
// the start-event day and `end` is the STOP-EVENT day — the first INACTIVE day, i.e.
// the pre-#2232 stored shape, NOT the inclusive `IllnessEpisode.end`.
export interface SituationRun {
  situation: string;
  start: string | null;
  end: string | null;
}

// Enumerate ALL on→off runs of one illness-type situation from the change-log, oldest
// first. Pairs consecutive start→stop transitions; a leading "stop" with no prior
// "start" is a before-log run (start null); an unclosed trailing "start" is ongoing
// (end null); a currently-active situation with NO events at all is one ongoing
// before-log run.
//
// FROZEN OUTPUT CONVENTION (#2232): the returned `end` is the stop event's own day —
// the exclusive first-inactive day — because this function's only production caller
// is the FROZEN migration 046 backfill, which wrote that shape into `ended_at`;
// migration 169 then converts those values to the inclusive `end_date`. Changing this
// to emit inclusive ends would make a from-scratch replay subtract a day twice. Live
// code reads stored rows (lib/illness-episode-store.ts), never this pairing.
export function episodesForSituation(
  name: string,
  events: readonly SituationEvent[],
  currentlyActive: boolean
): SituationRun[] {
  const ev = eventsFor(name, events);
  const episodes: SituationRun[] = [];
  let open: string | null | undefined = undefined;
  for (const e of ev) {
    if (e.change === "start") {
      if (open === undefined) open = e.date;
    } else {
      if (open === undefined) {
        episodes.push({ situation: name, start: null, end: e.date });
      } else {
        episodes.push({ situation: name, start: open, end: e.date });
        open = undefined;
      }
    }
  }
  if (open !== undefined) {
    episodes.push({ situation: name, start: open, end: null });
  } else if (currentlyActive && ev.length === 0) {
    episodes.push({ situation: name, start: null, end: null });
  }
  return episodes;
}
