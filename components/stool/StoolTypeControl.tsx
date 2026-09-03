"use client";

import { useEffect, useRef, useState } from "react";
import BristolStoolIcon from "@/components/BristolStoolIcon";
import { useWritePipeline } from "@/components/useWritePipeline";
import { useTimeStatement } from "@/components/TimeStatement";
import { BRISTOL_STOOL_TYPES } from "@/lib/bristol-stool";
import { logStoolForm } from "@/app/(app)/stool-actions";
import RollingNumber from "@/components/RollingNumber";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { microMotionPlan } from "@/lib/micro-motion";

// THE STOOL DOMAIN'S ROW CONTROL (#4424 ruling 7), named by
// `LOG_MANIFEST.stool.pieces.rowControl`: the Bristol Stool Form Scale as seven one-tap
// buttons over the day's running count. As `QuickStoolForm` it hand-rolled the commit
// dance — ledger wiring, the offline decision, the enqueue, the refused-capture
// sentence, the toast. `useWritePipeline` owns all of that now (#3276); what is left is
// what this domain's tap MEANS.
//
// WHY SEVEN BUTTONS AND NOT A SLIDER OR A NUMBER FIELD. The scale is CATEGORICAL-
// ORDINAL: the types are ordered, but the distance between them is not a quantity, and
// a slider invites the value between two of them that the scale does not define. Seven
// discrete targets also make the whole vocabulary visible at once, which is what makes
// a self-reported type comparable week to week — nobody remembers what "type 5" means,
// they recognize it.
//
// The number is therefore never TYPED here, which is the guard against a 0 or an 8 that
// matters most; `parseBristolType` re-asks in the action and again in the write core
// for a crafted post.
//
// EACH BUTTON CARRIES THE SCALE'S OWN DESCRIPTION as its accessible name, so a screen
// reader hears "Type 3, like a sausage but with cracks on the surface" rather than the
// two-word caption that has to fit on a phone. The glyph is decorative and hidden.
//
// **The sheet stays open after a tap**, like the food bar and the practice list: several
// movements a day is ordinary, and a person correcting a mis-tap should not have to
// reopen the sheet. The day's running count sits under the row so a second tap is
// informed. NO VERDICT — the count is a count, and nothing here says a type is good or
// bad (#2785 ships a recording surface; a finding is a later decision under the
// findings doctrine).
export default function StoolTypeControl({
  todayCount,
  today,
}: {
  // How many Bristol readings this profile already has for today, from the server.
  todayCount: number;
  // The acting profile's today (YYYY-MM-DD) — the day the count counts and the day
  // the action files a tap under, so the "happened earlier" statement is anchored on
  // the SERVER's day rather than on a browser that may have crossed midnight.
  // `TAP_REACH` files this as a `today` tap; a BACKFILL states its day on `StoolForm`.
  today: string;
}) {
  const pipeline = useWritePipeline("stool-form");
  const [count, setCount] = useState(todayCount);
  const reducedMotion = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reducedMotion);
  const [settlingType, setSettlingType] = useState<number | null>(null);
  const [settleRuns, setSettleRuns] = useState<Record<number, number>>({});
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Happened earlier?" (#3273), through the shared statement (#4426). A tap still
  // writes the tap instant — the one-tap ledger is the point — and this is the escape
  // hatch for the log that arrives late, the ordinary case for a bowel movement
  // (#2785's grain argument). A day EARLIER than today is the record's door, not this
  // tap's (`TAP_REACH`).
  const statement = useTimeStatement({
    day: today,
    timeLabel: "Time it happened",
    testId: "stool-when",
  });
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    []
  );

  function settle(type: number) {
    if (!settlePlan.animate) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setSettlingType(type);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setSettlingType(null);
    }, settlePlan.ms);
  }
  // Follow the server whenever it disagrees — a reading can be removed elsewhere (the
  // record's ⋯ now does), and a count frozen at mount would claim a day that moved.
  const [serverCount, setServerCount] = useState(todayCount);
  if (serverCount !== todayCount) {
    setServerCount(todayCount);
    setCount(todayCount);
  }
  async function tap(type: number) {
    // The statement THIS tap consumes, read once — both as the wall time it posts and
    // as the value the spend below compares against.
    const stated = statement.at;
    // OPTIMISTIC, THEN THE SERVER'S OWN TOTAL. The pipeline settles the ledger and says
    // the sentence; the COUNT is this surface's state, committed here as
    // `DoseStatusControl` commits its own override.
    const before = count;
    let landed: number | null = null;
    setCount(before + 1);
    const result = await pipeline.run({
      key: String(type),
      // ONLY when a time was actually stated, and never a day: the ABSENCE of each
      // field leaves the instant to the clock seam and the day to the action's `today`,
      // so an untouched sheet posts precisely the body it always posted (#3273).
      fields: { type: String(type), ...(stated ? { at: stated } : {}) },
      action: logStoolForm,
      settle: (res) => {
        if (!res.ok)
          return {
            wrote: false,
            announce: { message: res.error, tone: "error", undo: null },
          };
        landed = res.dayCount;
        settle(type);
        // Rule 4 of the shared statement: restating a minute CORRECTS the row the
        // first tap wrote rather than adding one, so the sheet cannot stay armed.
        statement.spend(stated);
        return {
          wrote: true,
          // WHAT LANDED, INCLUDING WHAT DID NOT (#4425). The stated time is judged at
          // the write boundary, and a time it refuses costs the statement rather than
          // the observation — so the sentence says the reading is filed at the moment
          // of the tap instead of the minute typed. The phrasing is this surface's own:
          // the user TYPED the time here, so the shared "your device's clock is ahead"
          // note would diagnose the wrong machine (lib/stated-time.ts says so). NO UNDO,
          // declared rather than forgotten: the record's ⋯ is where a movement is
          // removed, and the count beside the buttons already moved.
          announce: {
            message:
              res.statedTimeRefused === "future"
                ? `Logged type ${res.type} now — ${stated} hasn't happened yet.`
                : res.statedTimeRefused
                  ? `Logged type ${res.type} now — ${stated} isn't a time on this day.`
                  : stated
                    ? `Logged type ${res.type} at ${stated}`
                    : `Logged type ${res.type}`,
            undo: null,
          },
        };
      },
      failureMessage: "Couldn't log that. Try again.",
      offline: () => ({
        kind: "capture",
        flow: "stool",
        date: today,
        payload: { type, at: stated },
        keptMessage: "Saved offline — will sync when you reconnect.",
      }),
    });
    // The server's total is authoritative; a capture has no revalidate behind it, so
    // its +1 stands in until replay; nothing written rolls back.
    if (result === "wrote") setCount(landed ?? before + 1);
    else if (result === "nothing") setCount(before);
    else statement.spend(stated);
  }

  return (
    <div data-testid="quick-entry-stool">
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {BRISTOL_STOOL_TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            data-testid={`stool-type-${t.type}`}
            onClick={() => void tap(t.type)}
            aria-label={`Type ${t.type}, ${t.description}`}
            className="group relative flex flex-col items-center gap-1 px-1 py-2 text-slate-700 dark:text-slate-200"
          >
            <span
              aria-hidden="true"
              data-testid={`stool-settle-${t.type}`}
              data-motion="settle"
              data-reduced-motion={reducedMotion ? "true" : "false"}
              data-settling={settlingType === t.type ? "true" : "false"}
              data-motion-runs={settleRuns[t.type] ?? 0}
              onAnimationStart={() =>
                setSettleRuns((runs) => ({
                  ...runs,
                  [t.type]: (runs[t.type] ?? 0) + 1,
                }))
              }
              className={`absolute inset-0 rounded-lg border border-(--border) bg-surface transition group-hover:border-slate-400 dark:group-hover:border-slate-500${
                settlingType === t.type ? ` ${settlePlan.className}` : ""
              }`}
            />
            <span className="relative flex flex-col items-center gap-1">
              <BristolStoolIcon type={t.type} />
              <span className="text-sm font-medium tabular-nums">{t.type}</span>
              <span className="text-center text-xs leading-tight text-slate-500 dark:text-slate-400">
                {t.label}
              </span>
            </span>
          </button>
        ))}
      </div>
      {/* THE CLOCK DOOR (#4426's rendering ruling), in the row directly under the
          seven type buttons it modifies — this domain's action is the GRID, so
          "immediately right" has no single button to sit against and the door takes
          the first seat after it instead. It was a "Happened earlier?" text button
          here; the glyph is the only spelling now. */}
      <div className="mt-3 flex items-center gap-2">{statement.door}</div>
      {statement.reveal ? <div className="mt-2">{statement.reveal}</div> : null}
      <p
        data-testid="quick-entry-stool-count"
        className="mt-3 text-sm text-slate-500 dark:text-slate-400"
      >
        <RollingNumber
          value={count}
          testId="quick-entry-stool-rolling-count"
          format={(value) =>
            value === 0
              ? "Nothing logged today."
              : value === 1
                ? "1 logged today."
                : `${value} logged today.`
          }
        />
      </p>
    </div>
  );
}
