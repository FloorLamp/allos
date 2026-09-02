"use client";

import { useState, type ReactNode } from "react";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedHhmm } from "@/lib/stated-time";

// ONE COLLAPSED TIME STATEMENT (#4426), over the shared `WhenControl` (#2236) and in
// the #3273 vocabulary: "this happened at a different time than my tap". The app spoke
// it in four hand-rolled dialects, each spelling its own toggle, its own reveal and its
// own reset rule; the rules are stated HERE, once, and a mount supplies only what is
// genuinely its domain's — the words, the day, the field label, the ids.
//
// ── the four rules this hook owns ────────────────────────────────────────────
//
//   1. CLOSED AND EMPTY IS THE FAST PATH. No statement means no field on the post,
//      so an untouched surface sends exactly the body it always sent. That is why
//      `at` is `string | null` and never a coalesced now.
//   2. ONLY WHAT WAS ON SCREEN. `shown` is ONE expression read by both the render and
//      the write, so a surface that does not offer the statement cannot post one it
//      seeded for some other reason. A future condition on visibility is added to that
//      one argument and both halves follow it; put it in the JSX alone and the tap
//      posts a value nobody saw.
//   3. A STATEMENT BELONGS TO THE DAY IT WAS MADE ABOUT. `day` is server state on
//      surfaces that are left open (a sheet across local midnight), so a change DROPS
//      the statement rather than re-anchoring it: 23:50 said about yesterday is not a
//      claim about today, and re-anchoring would invent one in the future.
//   4. A STATEMENT IS SPENT BY THE TAP IT ANSWERS. These surfaces stay open for a
//      genuine second observation, and a second observation is a different time —
//      restating the same minute CORRECTS the row the first tap wrote instead of
//      adding one. `spend` takes what the tap CONSUMED and drops only that: the settle
//      runs arbitrarily later than the tap, so a statement made while the first write
//      was in flight must survive it.
export interface TimeStatement {
  /** The stated profile-local wall time this tap may post, or null. Rules 1 and 2. */
  at: string | null;
  /** The same statement as an absolute instant (ISO UTC), for an offline capture. */
  instant: string | null;
  /** Rule 4: drop the statement `consumed` paid for, and only that one. */
  spend: (consumed: string | null) => void;
  /** The toggle and its revealed control, or null where the surface does not offer it. */
  node: ReactNode;
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
  // The profile-local day the statement is anchored on (rule 3). The day is FIXED:
  // this control states a TIME, never a DAY (#4118) — reaching another day is the
  // record's own dated door.
  day: string;
  // The toggle's words, and its accessible name. The domain's verb ("Happened
  // earlier?", "Taken earlier?").
  label: string;
  // The time field's label, in the domain's own words.
  timeLabel: string;
  // `{testId}-toggle` names the button; the `WhenControl` beneath takes `testId`
  // itself, so its shipped `-date` / `-time` ids are unchanged.
  testId: string;
  // The TARGET profile's zone where a host logs for someone else; the acting
  // profile's otherwise.
  tz?: string;
  disabled?: boolean;
  className?: string;
}): TimeStatement {
  const contextTz = useTimezone();
  const tz = tzProp ?? contextTz;
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState<WhenValue>({ date: day, statedAt: null });
  // Rule 3, as a render-phase follower rather than an effect: the drop must land on
  // the same commit the new day does, or one render posts against the old one.
  const [seenDay, setSeenDay] = useState(day);
  if (seenDay !== day) {
    setSeenDay(day);
    setWhen({ date: day, statedAt: null });
  }

  const at = shown ? statedHhmm(when.statedAt, tz) || null : null;
  return {
    at,
    instant: at ? when.statedAt : null,
    spend: (consumed) =>
      setWhen((prev) =>
        statedHhmm(prev.statedAt, tz) === (consumed ?? "")
          ? { date: day, statedAt: null }
          : prev
      ),
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
        {open ? (
          <div className="mt-2">
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
          </div>
        ) : null}
      </div>
    ) : null,
  };
}
