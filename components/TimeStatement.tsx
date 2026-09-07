"use client";

import { useState, type ReactNode } from "react";
import { IconClock } from "@tabler/icons-react";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import {
  DOSE_ACTION_ICON,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { statedHhmm, statedInstantOnDate, whenOnDay } from "@/lib/stated-time";

// Shared accessible name for the clock toggle.
export const HAPPENED_EARLIER = "Happened earlier?";

// The host owns the day; this control owns a visible, optional time statement.
// Day changes clear the statement. A successful write consumes only its own time,
// preserving a newer edit made while it was pending. Proposals open visibly.
export interface TimeStatement {
  /** The visible profile-local wall time this tap may post; null when absent or hidden. */
  at: string | null;
  /** The same statement as an absolute instant (ISO UTC), for an offline capture. */
  instant: string | null;
  /** Clear only the statement consumed by this write. */
  spend: (consumed: string | null) => void;
  /** Seat the door beside the action and the labelled reveal below it. */
  door: ReactNode;
  reveal: ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
}

// Resolve a proposed wall time on the host's validated day.
function seedWhen(day: string, proposed: string | null, tz: string): WhenValue {
  const { date } = whenOnDay(day, tz);
  return {
    date,
    statedAt: proposed
      ? (statedInstantOnDate(date, proposed, tz)?.toISOString() ?? null)
      : null,
  };
}

export function useTimeStatement({
  shown = true,
  day,
  proposed = null,
  timeLabel,
  testId,
  tz: tzProp,
  disabled = false,
}: {
  // Visibility controls both rendering and the value available to submit.
  shown?: boolean;
  day: string;
  /** Optional profile-local HH:MM, revealed before it can be submitted. */
  proposed?: string | null;
  // Visible label for the revealed time field.
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
  const [open, setOpen] = useState(proposed !== null);
  const [when, setWhen] = useState<WhenValue>(() =>
    seedWhen(day, proposed, tz)
  );
  // Follow day/proposal changes before a render can submit the old statement.
  const [seenDay, setSeenDay] = useState(day);
  const [seenProposed, setSeenProposed] = useState(proposed);
  if (seenDay !== day || seenProposed !== proposed) {
    const proposalChanged = seenProposed !== proposed;
    setSeenDay(day);
    setSeenProposed(proposed);
    setWhen(seedWhen(day, proposed, tz));
    // A proposal arrives WITH its reveal; a day change alone leaves the door as the
    // user left it.
    if (proposalChanged && proposed !== null) setOpen(true);
  }

  const at = shown ? statedHhmm(when.statedAt, tz) || null : null;
  // The revealed control itself, WITHOUT surrounding spacing — where it sits in a
  // layout is the host's, which is the whole reason a host renders this piece rather
  // than `node`. `minDate === maxDate` is the day clause above made structural: the
  // shared control renders a FIXED day as text and offers no picker, so no mount can
  // state a day through it however it is hosted.
  const reveal =
    shown && open ? (
      <>
        {/* `WhenControl` names its time input `{testId}-time`, which is what this
            points at — one label, visible and associated, rather than a second
            spelling of the accessible name the control already carries. */}
        <label className="label" htmlFor={`${testId}-time`}>
          {timeLabel}
        </label>
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
      </>
    ) : null;
  return {
    at,
    instant: at ? when.statedAt : null,
    spend: (consumed) =>
      setWhen((prev) =>
        statedHhmm(prev.statedAt, tz) === (consumed ?? "")
          ? seedWhen(day, null, tz)
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
