// THE PRACTICE FINISH MESSAGE (#4775 §3) — the one send in this app that WAITS FOR
// ITS OWN EVIDENCE before it exists.
//
// A workout's finish message has something to say the moment the row lands: the sets,
// the distance, the weekly target. A practice does not. "🧘 Sauna done" is the tap
// read back to the person who just made it, and #1259's whole anti-nudge stance says
// not to send that. What makes this worth a message is the number — what the practice
// did to the heart rate — and that number is NOT AVAILABLE AT THE TAP, because the
// Health Connect pipeline runs 30–61 min behind the wrist (#2560).
//
// So the rule is inverted from every other send here: NO PHYSIOLOGY, NO SEND. Not a
// degraded message, not a message with the clause omitted — nothing. A profile with no
// continuous stream never receives this kind at all, and that is correct rather than a
// gap, because for that profile the message would say only what the tap already said.
//
// ── Why there is no armed-state column ───────────────────────────────────────
//
// The issue describes the tick "arming the row at write time". A row that carries a
// start and a duration IS the armed state: the tick asks, on each pass, which practice
// rows ended inside the bound and have no marker. That is the same set an armed flag
// would name, with nothing to write at the tap, nothing to sweep when a row is deleted
// or re-dated, and no way for the flag and the row to disagree after an edit. A
// migration that adds a column the row's own fields already answer is a second copy of
// the same fact.
//
// ── The bound, and what it is bounding ───────────────────────────────────────
//
// Two hours after the window's END. That is the quantity the lag is measured in — the
// pipeline's own p99 frontier-advance interval is 81 minutes (#2560) — so two hours is
// "the pipeline has had its slowest realistic push and then some". Past it the moment
// has gone: a message about a sauna three hours ago is a bulletin, not a finish note.
// A row that never gains coverage inside the bound sends NOTHING and BURNS NOTHING —
// the marker is the record of a send, so an unsent row must leave it unset.

import { GLYPH } from "./glyphs";
import {
  practiceEffectBpm,
  usualValue,
  type EventPhysiology,
} from "../event-physiology";

/**
 * Two hours after the window's end. See the header for what this bounds.
 *
 * IT IS BOTH BOUNDS, AND NO PIPELINE SPEED MOVES EITHER (#5127 review). It carries two
 * rules that happen to be the same number: a RETRY window, which a quicker pipeline may
 * not lower because the send already fires the moment coverage arrives; and a MOMENT
 * rule — "a bulletin, not a finish note" — which a slower one may not raise. #5001 made
 * this the default and the floor of a measured wait; the cap is this same constant, so
 * the window the dispatch computes is exactly two hours for every profile.
 *
 * An earlier draft of this comment promised a quicker profile "its own, shorter answer".
 * No profile ever got one, and a stale comment on THIS constant is how the narrowing
 * defect got in the first time. The dispatch reads it through `arrivalWait`, for that
 * model's vocabulary rather than for a measurement; nothing else may.
 */
export const PRACTICE_RECAP_BOUND_MIN = 120;

export const PRACTICE_RECAP_MARKER_PREFIX = "notify_last_practice_recap_";

/** One-shot per practice ROW. Ids never recycle (#203), so this can never re-attach. */
export function practiceRecapMarkerKey(practiceLogId: number): string {
  return `${PRACTICE_RECAP_MARKER_PREFIX}${practiceLogId}`;
}

/** What the message states, or null when there is no physiology to state. */
export interface PracticeRecapFacts {
  practice: string;
  /** The window's own length in minutes — derived or observed, see `derivedWindow`. */
  durationMin: number;
  /** The window came from the practice's usual duration rather than an End tap. */
  derivedWindow: boolean;
  meanBpm: number;
  /** In-window mean minus the profile's resting reference. Signed, never scored. */
  effectBpm: number;
  /** The same figure over this practice's prior windowed sessions, or null. */
  usualEffectBpm: number | null;
}

/**
 * The facts for one finished practice, or null when the send must not happen.
 *
 * FOUR ways this is null, and they are the send's whole gate:
 *   • the stream has not covered the window (the lag — the common case at the tap);
 *   • nothing was measured inside the window (the watch was off);
 *   • the profile has no resting-HR reference to state the rise over;
 *   • …which together mean the message would repeat the tap. So it does not go.
 */
export function practiceRecapFacts(input: {
  practice: string;
  physiology: EventPhysiology;
  derivedWindow: boolean;
  restingReferenceBpm: number | null;
  /** The same effect over prior windowed sessions of THIS practice, newest first. */
  priorEffectsBpm: readonly number[];
}): PracticeRecapFacts | null {
  const { physiology } = input;
  if (!physiology.covered || !physiology.inWindow) return null;
  const effectBpm = practiceEffectBpm(physiology, input.restingReferenceBpm);
  if (effectBpm == null) return null;
  return {
    practice: input.practice,
    durationMin: Math.round(
      windowLengthMin(physiology.window.start, physiology.window.end)
    ),
    derivedWindow: input.derivedWindow,
    meanBpm: physiology.inWindow.meanBpm,
    effectBpm,
    usualEffectBpm: usualValue(input.priorEffectsBpm),
  };
}

function windowLengthMin(start: string, end: string): number {
  const toMin = (local: string) => {
    const [date, time] = local.split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [h, min] = time.split(":").map(Number);
    return Date.UTC(y, m - 1, d, h, min) / 60_000;
  };
  return toMin(end) - toMin(start);
}

/** A signed bpm figure, always carrying its sign: "+35", "−8". */
function signed(bpm: number): string {
  const n = Math.round(bpm);
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}

/**
 * The message body: `🧘 Red light therapy done · 15 min · HR 95 avg, +35 over resting
 * (usual +24)`.
 *
 * DIRECTION IS STATED, NEVER SCORED. A sauna's rise and a meditation's fall are both
 * "what it did", and the copy has no word in it that says which is better — this app
 * does not know, and neither does the literature for an individual's own panel.
 *
 * A DERIVED window says so ("about 15 min"). The row's length came from the practice's
 * usual duration rather than an End tap, and #3143's honesty rule is that a derived
 * figure is never printed as an observed one.
 */
export function practiceRecapBody(facts: PracticeRecapFacts): string {
  const length = facts.derivedWindow
    ? `about ${facts.durationMin} min`
    : `${facts.durationMin} min`;
  const usual =
    facts.usualEffectBpm != null
      ? ` (usual ${signed(facts.usualEffectBpm)})`
      : "";
  return [
    `${facts.practice} done`,
    length,
    `HR ${Math.round(facts.meanBpm)} avg, ${signed(facts.effectBpm)} over resting${usual}`,
  ].join(" · ");
}

export function practiceRecapTitle(): string {
  return `${GLYPH.practice} Practice complete`;
}
