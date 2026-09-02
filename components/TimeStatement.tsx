"use client";

import { useState, type ReactNode } from "react";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedHhmm } from "@/lib/stated-time";

// ONE COLLAPSED TIME STATEMENT (#4426), over the shared `WhenControl` (#2236) and in
// the #3273 vocabulary: "this happened at a different time than my tap". The app spoke
// that sentence in four hand-rolled dialects, each spelling its own toggle, its own
// reveal and its own answer to what the tap does to the statement. The rules are stated
// HERE, once; a mount supplies only what is genuinely its domain's.
//
//   1. CLOSED AND EMPTY IS THE FAST PATH. No statement means no field on the post, so
//      an untouched surface sends the body it always sent — hence `string | null`,
//      never a coalesced now.
//   2. ONLY WHAT WAS ON SCREEN. `shown` is ONE expression read by both the render and
//      the write, so a future condition on visibility is added to that one argument and
//      both halves follow it. Put it in the JSX alone and the tap posts a value nobody
//      saw.
//   3. A STATEMENT BELONGS TO THE DAY IT WAS MADE ABOUT. `day` is server state on a
//      surface people leave open, so a change DROPS the statement rather than
//      re-anchoring it: 23:50 said about yesterday is not a claim about today, and
//      re-anchoring would invent one in the future.
//   4. A STATEMENT IS SPENT BY THE TAP IT ANSWERS. These surfaces stay open for a
//      genuine second observation, and a second observation is a different time —
//      restating a minute CORRECTS the row the first tap wrote instead of adding one.
//      `spend` takes what the tap CONSUMED and drops only that, because the settle runs
//      arbitrarily later than the tap: a statement made while the write was in flight
//      must survive it.
export interface TimeStatement {
  /** The stated profile-local wall time this tap may post, or null (rules 1 and 2). */
  at: string | null;
  /** The same statement as an absolute instant (ISO UTC), for an offline capture. */
  instant: string | null;
  /** Rule 4: drop the statement `consumed` paid for, and only that one. */
  spend: (consumed: string | null) => void;
  /** The toggle and its reveal together, or null where the surface does not offer them. */
  node: ReactNode;
  /**
   * THE SAME STATEMENT, ADDRESSABLE IN TWO PIECES — for a surface whose toggle is
   * already one of its domain action buttons and whose reveal belongs somewhere else
   * in the layout. The PRN row is that surface: "Earlier dose" sits in a two-button
   * cluster measured against "Taken now", and the reveal opens in the row's FOOTER,
   * so no single node can be in both places.
   *
   * THIS IS NOT A MODE (#4738 ruling 2). Nothing about the statement's behaviour
   * changes with which piece a host renders — same state, same reveal, same four
   * rules — and there is no prop to pass, so the control cannot grow a second
   * behaviour by being configured into one. What a host chooses is where the two
   * halves are DRAWN, which was always the host's.
   */
  reveal: ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function useTimeStatement({
  shown = true,
  day,
  label,
  timeLabel,
  testId,
  tz: tzProp,
  disabled = false,
  className,
}: {
  // Rule 2 — the ONE expression the render and the write both read.
  shown?: boolean;
  // The day the statement is anchored on (rule 3), and it is FIXED here: this control
  // is the TIME half, and THE DAY COMES FROM THE SURFACE'S DAY CONTEXT (#4118, stated
  // whole by #4738's ruling 1) — the form's DateField, the history door's record day,
  // the quick-log sheet's day switcher, or a card-wide day context. That is what lets
  // one statement serve create and edit: edit seeds the day from the row, create takes
  // it from the surface, and the statement is the same control in both. A mount that
  // wants to reach another day moves its SURFACE's day, never this control's.
  day: string;
  // The domain's verb, as the toggle's words and its accessible name.
  label: string;
  timeLabel: string;
  // `{testId}-toggle` names the button; the `WhenControl` takes `testId` itself, so
  // its shipped `-date` / `-time` ids are unchanged.
  testId: string;
  // The TARGET profile's zone where a host logs for someone else.
  tz?: string;
  disabled?: boolean;
  className?: string;
}): TimeStatement {
  const contextTz = useTimezone();
  const tz = tzProp ?? contextTz;
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState<WhenValue>({ date: day, statedAt: null });
  // Rule 3 as a render-phase follower, not an effect: the drop lands on the same
  // commit the new day does, so no render can post against the day that left.
  const [seenDay, setSeenDay] = useState(day);
  if (seenDay !== day) {
    setSeenDay(day);
    setWhen({ date: day, statedAt: null });
  }

  const at = shown ? statedHhmm(when.statedAt, tz) || null : null;
  // The revealed control itself, WITHOUT surrounding spacing — where it sits in a
  // layout is the host's, which is the whole reason a host renders this piece rather
  // than `node`. `minDate === maxDate` is the day clause above made structural: the
  // shared control renders a FIXED day as text and offers no picker, so no mount can
  // state a day through it however it is hosted.
  const reveal =
    shown && open ? (
      <WhenControl
        mode="state"
        grain="minute"
        value={when}
        onChange={setWhen}
        tz={tz}
        minDate={day}
        maxDate={day}
        timeLabel={timeLabel}
        disabled={disabled}
        testId={testId}
      />
    ) : null;
  return {
    at,
    instant: at ? when.statedAt : null,
    spend: (consumed) =>
      setWhen((prev) =>
        statedHhmm(prev.statedAt, tz) === (consumed ?? "")
          ? { date: day, statedAt: null }
          : prev
      ),
    open,
    setOpen,
    reveal,
    node: shown ? (
      <div className={className}>
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost btn-sm"
        >
          {label}
        </button>
        {reveal ? <div className="mt-2">{reveal}</div> : null}
      </div>
    ) : null,
  };
}
