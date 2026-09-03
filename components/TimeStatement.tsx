"use client";

import { useState, type ReactNode } from "react";
import { IconClock } from "@tabler/icons-react";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import {
  DOSE_ACTION_ICON,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { statedHhmm } from "@/lib/stated-time";

// THE CLOCK GLYPH IS THE ONLY SPELLING OF THIS TOGGLE (#4426's rendering ruling,
// 2026-09-02), so it is not a `label` prop any more and no mount can choose words —
// four dialects said this one sentence four ways. The question is the ACCESSIBLE NAME
// and never a `title=`: #2378/#3375 ruled hover-only text out of this codebase because
// a touch or keyboard reader never receives it, and
// lib/__tests__/raw-title-boundary.test.ts holds that line.
export const HAPPENED_EARLIER = "Happened earlier?";

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
  /**
   * ALWAYS TWO PIECES, because the halves belong in two places: the door sits in the
   * ACTION ROW immediately right of the action it modifies, the reveal opens BELOW
   * that row where a day, a minute and a save button have room. There is no third
   * node combining them — one could only ever be in one of the two places, and the
   * mount that seated it correctly was the one that hand-rolled its own door.
   *
   * THIS IS NOT A MODE (#4738 ruling 2): same state, same reveal, same four rules
   * wherever a host draws them, and no prop to pass.
   */
  door: ReactNode;
  reveal: ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function useTimeStatement({
  shown = true,
  day,
  timeLabel,
  testId,
  tz: tzProp,
  disabled = false,
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
  // The revealed field's own label. The DOOR takes no words from a mount (see
  // `HAPPENED_EARLIER`); this names the minute being stated, which is the domain's.
  timeLabel: string;
  // `{testId}-toggle` names the button; the `WhenControl` takes `testId` itself, so
  // its shipped `-date` / `-time` ids are unchanged.
  testId: string;
  // The TARGET profile's zone where a host logs for someone else.
  tz?: string;
  disabled?: boolean;
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
    // THE STANDARD 34px ICON BUTTON (#3938's control box). `dose-action-styles` is
    // already the shared language of these rows — practices and protocols import it
    // beside medications — so the door wears the same box as the action it sits
    // against rather than a fifth one.
    door: shown ? (
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label={HAPPENED_EARLIER}
        className={`${DOSE_ACTION_ICON} ${DOSE_ACTION_NEUTRAL}`}
      >
        <IconClock className="h-4 w-4" stroke={2} />
        <span className="sr-only">{HAPPENED_EARLIER}</span>
      </button>
    ) : null,
  };
}
