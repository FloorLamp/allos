// ONE OPEN EPISODE (#5142) — the single reading of "is this still going?"
//
// Four things in this app are episodes a person starts and may never explicitly
// finish: a live practice, a workout draft, a fast, and a night the app is waiting
// to arrive. Each answered "still going?" with its own machine — its own bound, its
// own comparison, its own word for having given up — so every new close rule was
// written into one of them and not the others (#3143 named the practice bound "the
// fasting shape" and then built a second copy of it).
//
// This module is that question asked once. The domains keep their rows and their
// columns; an episode is a READING over them, the way `computeWorkoutPresence`
// already reads `activities`. Nothing new is stored.

// ── What the reading is over ────────────────────────────────────────────────────

export type EpisodeKind = "practice" | "workout" | "fast";

export interface OpenEpisode {
  kind: EpisodeKind;

  // THE FRESHEST EVIDENCE THIS EPISODE IS STILL HAPPENING, as an epoch instant.
  //
  // Not the start, and that is the correction this model makes to the spec's shape.
  // A practice and a fast produce no evidence after their first tap, so their
  // freshest evidence IS the start and the bound has always run from it. A workout
  // draft bumps `updated_at` on every set (#451), so its bound has always run from
  // the last save — a model keyed on `startedAt` cannot express that, and a model
  // keyed on the last signal expresses all three, with the start being the last
  // signal for two of them.
  //
  // Elapsed-since-start is a display quantity, not a lifecycle one: each domain
  // already computes its own (the dock's "for 47 min", the fast's label, the
  // practice duration the End tap writes), so it does not live here.
  lastSignalAt: number;

  // WHEN THE EPISODE'S OWN RECORD SAYS IT ENDS, if it knows — a usual duration
  // stamped at Start (#5091), a measured trace end (#5113), a wearable session.
  // `null` when nothing but a tap can end it.
  expectedEnd: number | null;
}

// ── The bounds, all four in one table (AC 4) ────────────────────────────────────
//
// `staleMin` — quiet past which the episode stops reading as in progress and starts
// reading as "you probably forgot". A SUGGEST: it is what raises "Still going?".
// `abandonMin` — quiet past which the app stops holding the episode open on its own.
// `null` means only the person closes this kind: ending a fast and never fasting are
// different truths and only they know which happened (`lib/fasting.ts`), and workout
// presence never auto-ends a session either — it drops the draft from the dock.
export interface EpisodeBounds {
  staleMin: number;
  abandonMin: number | null;
}

export const EPISODE_BOUNDS = {
  // Six hours is longer than any practice this app is a logger for — a sauna, a
  // meditation, a mobility block — and short enough that a Start tapped in the
  // evening is abandoned before the next morning's page load (#3143). That is the
  // ABANDON bound and it has not moved.
  //
  // NINETY MINUTES IS THE NUDGE, and it is a real window now (#5142 AC 3). Practice
  // used to reach both bounds at once — the moment it stopped reading as in progress
  // was the moment the sweep cleared it — because it had no "Still going?" to send
  // and a suggest nobody sends needs no window to be sent in. Now that it has one,
  // the two numbers answer two questions: ninety minutes of silence is past every
  // practice this app is a logger for, so the question does not interrupt anyone
  // mid-sauna; and it leaves four and a half hours in which the person can answer
  // before the sweep clears the row, so the nudge never races its own deadline.
  //
  // The shorter half of the choice is the moment rule this repo already keeps for the
  // practice recap (#5127): a message about a sauna three hours ago is a bulletin,
  // not a question. Half the abandon bound would have been the tidier ratio and the
  // worse message.
  //
  // It only ever fires on a row with NO history: a practice with a usual duration
  // stamps its own expected end at Start and completes itself there (#5091), so it
  // is finished long before any bound is reached. This is the first sauna, not the
  // hundredth — which is also why the number cannot be derived from the usual.
  practice: { staleMin: 90, abandonMin: 6 * 60 },
  // A genuine live session bumps its auto-save every set, so 45 minutes of silence
  // means it is very likely done (#560). The draft is held for 90 so that `stale` is
  // an observable sub-state the hourly tick can fire inside (#921).
  workout: { staleMin: 45, abandonMin: 90 },
  // 36 h is the top of the commonly-practised extended-fast range — long enough that
  // a real 24 h fast is never nagged, short enough that a forgotten one surfaces the
  // same day. Nothing auto-ends it (#2756).
  fast: { staleMin: 36 * 60, abandonMin: null },
} as const satisfies Record<EpisodeKind, EpisodeBounds>;

// ── The reading ─────────────────────────────────────────────────────────────────
//
// ONE outcome vocabulary for all three, replacing three ways of saying "abandoned":
//
//   running   — inside its bounds, and the app expects more of it.
//   stale     — past `staleMin`. STILL OPEN: every resolution the person had is
//               still offered, and one more ("discard") is added. A suggest never
//               takes an answer away.
//   abandoned — past `abandonMin`. The app gives up holding it open and invents
//               nothing: what was observed is what the row keeps.
//   finished  — the episode knew its own end and that instant has passed.
export type EpisodeState =
  | { kind: "running"; quietMin: number }
  | { kind: "stale"; quietMin: number }
  | { kind: "abandoned"; quietMin: number }
  | { kind: "finished"; endedAt: number };

export function episodeState(episode: OpenEpisode, now: number): EpisodeState {
  // FINISHED IS READ FIRST, AND NO BOUND REACHES IT. A row that knew its own end
  // knew it whether or not anything swept in time to write it — a Start at 06:28 on
  // a 15-minute practice ended at 06:43 even if nothing ran until the evening.
  // Letting the abandonment branch reach it first would discard an end the row
  // already had, which is the same defect one step removed.
  if (episode.expectedEnd != null && now >= episode.expectedEnd)
    return { kind: "finished", endedAt: episode.expectedEnd };

  const bounds = EPISODE_BOUNDS[episode.kind];
  const quietMin = (now - episode.lastSignalAt) / 60_000;

  // ONE COMPARISON CONVENTION, and it is the one all three domains already used:
  // reaching `staleMin` raises the suggest, and the episode must PASS `abandonMin`
  // before the app gives up.
  //
  // Quiet is the only question asked here. Whether an episode's evidence is itself
  // plausible — a start stranded ahead of the clock by a westward timezone edit — is
  // a claim about the ROW, and the domain that stores the row asks it: a practice
  // start is a wall clock on a stored day, a workout draft's last save is a server
  // stamp, and they do not deserve the same tolerance for reading as future.
  if (bounds.abandonMin != null && quietMin > bounds.abandonMin)
    return { kind: "abandoned", quietMin };
  if (quietMin >= bounds.staleMin) return { kind: "stale", quietMin };
  return { kind: "running", quietMin };
}

/** The two states in which the episode is still going: running, or gone quiet. */
export type OpenEpisodeState = Extract<
  EpisodeState,
  { kind: "running" | "stale" }
>;

/**
 * Is this still an episode the app will complete — one a tap, a measurement or a
 * sweep can still resolve? `stale` is open: it has a suggest on it, not a verdict.
 */
export function episodeIsOpen(state: EpisodeState): state is OpenEpisodeState {
  return state.kind === "running" || state.kind === "stale";
}
