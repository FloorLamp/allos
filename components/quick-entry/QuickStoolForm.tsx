"use client";

import { useEffect, useRef, useState } from "react";
import BristolStoolIcon from "@/components/BristolStoolIcon";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { BRISTOL_STOOL_TYPES } from "@/lib/bristol-stool";
import { logStoolForm } from "@/app/(app)/stool-actions";
import RollingNumber from "@/components/RollingNumber";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { microMotionPlan } from "@/lib/micro-motion";

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
}: {
  // How many Bristol readings this profile already has for today, from the server.
  todayCount: number;
}) {
  const toast = useToast();
  const ledger = useOptimisticLedger<number>("stool-form");
  const [count, setCount] = useState(todayCount);
  const reducedMotion = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reducedMotion);
  const [settlingType, setSettlingType] = useState<number | null>(null);
  const [settleRuns, setSettleRuns] = useState<Record<number, number>>({});
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  async function tap(type: number) {
    await ledger.tap({
      key: String(type),
      from: count,
      optimistic: count + 1,
      commit: setCount,
      write: () => {
        const fd = new FormData();
        fd.set("type", String(type));
        return logStoolForm(fd);
      },
      settle: (res) => {
        if (!res.ok) {
          toast(res.error, { tone: "error" });
          return { kind: "rollback" };
        }
        settle(type);
        toast(`Logged type ${res.type}`);
        return { kind: "adopt", value: res.todayCount };
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
