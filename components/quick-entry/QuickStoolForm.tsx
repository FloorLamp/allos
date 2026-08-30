"use client";

import { useEffect, useRef, useState } from "react";
import BristolStoolIcon from "@/components/BristolStoolIcon";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useTimezone } from "@/components/TimezoneProvider";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { BRISTOL_STOOL_TYPES } from "@/lib/bristol-stool";
import { statedHhmm } from "@/lib/stated-time";
import { logStoolForm } from "@/app/(app)/stool-actions";
import RollingNumber from "@/components/RollingNumber";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { microMotionPlan } from "@/lib/micro-motion";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";

// The quick-entry overlay's STOOL form (issue #2785): the Bristol Stool Form Scale as
// seven one-tap buttons.
//
// WHY SEVEN BUTTONS AND NOT A SLIDER OR A NUMBER FIELD. The scale is CATEGORICAL-
// ORDINAL: the types are ordered, but the distance between them is not a quantity, and
// a slider invites the value between two of them that the scale does not define. Seven
// discrete targets also make the whole vocabulary visible at once, which is what makes
// a self-reported type comparable week to week — nobody remembers what "type 5" means,
// they recognize it.
//
// The picker is therefore the ONLY entry surface, and that is the guard against a 0 or
// an 8 that matters most: the number is never typed. `parseBristolType` re-asks in the
// action and again in the write core for a crafted post, so the vocabulary is checked
// on all three paths and by the same question.
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
export default function QuickStoolForm({
  todayCount,
  today,
}: {
  // How many Bristol readings this profile already has for today, from the server.
  todayCount: number;
  // The acting profile's today (YYYY-MM-DD) — the day the count counts and the day
  // the action files a tap under, so the "happened earlier" statement is anchored on
  // the SERVER's day rather than on a browser that may have crossed midnight.
  today: string;
}) {
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const tz = useTimezone();
  const ledger = useOptimisticLedger<number>("stool-form");
  const [count, setCount] = useState(todayCount);
  const reducedMotion = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reducedMotion);
  const [settlingType, setSettlingType] = useState<number | null>(null);
  const [settleRuns, setSettleRuns] = useState<Record<number, number>>({});
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Happened earlier?" (#3273): the collapsed statement of WHEN, the one the sheet's
  // instant-event forms share. Closed and empty by default, so the fast path is
  // untouched — no statement means no `at` field, and the write core reads the clock
  // seam exactly as it did before this control existed.
  const [whenOpen, setWhenOpen] = useState(false);
  const [when, setWhen] = useState<WhenValue>({ date: today, statedAt: null });
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
  // Follow the server whenever it disagrees — a reading can be removed elsewhere, and
  // a local count frozen at mount would keep claiming a day that no longer holds it.
  const [serverCount, setServerCount] = useState(todayCount);
  if (serverCount !== todayCount) {
    setServerCount(todayCount);
    setCount(todayCount);
  }
  // Follow `today` for the same reason the count does — the same follower
  // LogPracticeButton spends on this same control. Mounting it is what created the
  // need: the sheet's props are gathered when it opens, so one left across local
  // midnight would offer yesterday as its fixed day while the action files under the
  // server's today, landing a stated 23:50 at TODAY's 23:50 — in the future. A day
  // change DROPS the statement rather than re-anchoring it: 23:50 said about
  // yesterday is not a claim about today.
  const [whenDay, setWhenDay] = useState(today);
  if (whenDay !== today) {
    setWhenDay(today);
    setWhen({ date: today, statedAt: null });
  }

  async function tap(type: number) {
    // The statement THIS tap consumes, read once — both as the wall time it posts and
    // as the instant the settle below compares against.
    const consumed = when.statedAt;
    const stated = statedHhmm(consumed, tz) || null;
    const spendStatement = () =>
      setWhen((prev) =>
        prev.statedAt === consumed ? { date: today, statedAt: null } : prev
      );
    await ledger.tap({
      key: String(type),
      from: count,
      optimistic: count + 1,
      commit: setCount,
      write: () => {
        const fd = new FormData();
        fd.set("type", String(type));
        // ONLY when a time was actually stated. The field's ABSENCE is what tells
        // the action to leave the instant to the clock seam, so an untouched sheet
        // posts precisely the body it posted before (#3273's byte-identity rule).
        if (stated) fd.set("at", stated);
        return logStoolForm(fd);
      },
      settle: (res) => {
        if (!res.ok) {
          toast(res.error, { tone: "error" });
          return { kind: "rollback" };
        }
        settle(type);
        toast(
          stated
            ? `Logged type ${res.type} at ${stated}`
            : `Logged type ${res.type}`
        );
        // A STATEMENT IS SPENT BY THE TAP IT ANSWERS. The key is the instant, so a
        // second tap under a surviving statement would restate the same minute — and
        // restating a minute CORRECTS that reading rather than adding one (the write
        // core's own rule). The sheet stays open for a genuine second movement, and a
        // second movement is a different time; leaving the field armed would silently
        // overwrite the row the first tap just wrote.
        //
        // ONLY THE STATEMENT THIS TAP SPENT, and the guard is not defensive. This runs
        // when the WRITE ANSWERS, which is arbitrarily later than the tap: a person who
        // taps, then opens the affordance and states 07:05 while the request is still
        // in flight, would have had that statement wiped by a settle belonging to the
        // previous tap — and the next tap would then collide with the row that one
        // wrote instead of adding a reading. A functional update comparing against what
        // was consumed leaves anything newer alone.
        spendStatement();
        return { kind: "adopt", value: res.todayCount };
      },
      onError: async (err) => {
        if (!shouldQueueOffline(navigator.onLine, err)) return undefined;
        const kept =
          (await enqueue("stool", today, { type, at: stated })) === "kept";
        if (!kept) {
          toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, { tone: "error" });
          return undefined;
        }
        settle(type);
        spendStatement();
        toast("Saved offline — will sync when you reconnect.");
        return { kind: "keep" };
      },
    });
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
      {/* The collapsed WHEN (#3273). A tap still writes the tap instant — the one-tap
          ledger is the point — and this is the escape hatch for the log that arrives
          late, which for a bowel movement is the ordinary case (#2785's grain
          argument). Absolute local times only, via the shared control: no "-2h" chip
          that means something different every minute the sheet sits open. */}
      <div className="mt-3">
        <button
          type="button"
          data-testid="stool-when-toggle"
          aria-expanded={whenOpen}
          onClick={() => setWhenOpen((open) => !open)}
          className="btn-ghost btn-sm"
        >
          Happened earlier?
        </button>
        {whenOpen ? (
          <div className="mt-2">
            <WhenControl
              mode="state"
              grain="minute"
              value={when}
              onChange={setWhen}
              minDate={today}
              maxDate={today}
              timeLabel="Time it happened"
              testId="stool-when"
            />
          </div>
        ) : null}
      </div>
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
