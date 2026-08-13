"use client";

import { useEffect, useRef, useState } from "react";
import { microMotionPlan } from "@/lib/micro-motion";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";

// THE FOLD ANSWERING (#2654, motion 2) — the "Snoozed & dismissed" summary line on
// /upcoming, which pulses once when its count goes up.
//
// The pair to the dismissed row's travel: the row slides toward this line, and this
// line catches it. Together they teach the one thing the #2386 doctrine guarantees
// and no static page ever says out loud — dismissed is not deleted, and HERE is where
// to look for it again.
//
// The contract, in the order it matters:
//
//  * THE COUNT IS ALWAYS THE TRUTH IN THE TEXT. It renders verbatim on the server, on
//    the first client paint and on every mount. The pulse is decoration on a number
//    that is already correct, so a screen reader, a no-JS reader and an exact-text
//    assertion all read the real count.
//  * MOUNT NEVER PULSES, and neither does a count going DOWN. A pulse on arrival
//    would be an attention claim made at someone who merely opened the page, which is
//    the "a finding may not campaign" line; a pulse on a Restore would celebrate the
//    fold LOSING a row, which is the opposite fact. Only an increment — the fold
//    catching something — pulses.
//  * NOTHING LOOPS. One run per increment, and the class comes back off.
//  * Reduced motion is the designed state: `microMotionPlan` returns no class and no
//    duration, and the new count is simply there. Published as `data-reduced-motion`
//    so the browser suite can prove the branch was taken without timing anything.
//
// The 500 ms duration is OUTSIDE the 150–300 ms band, by owner ruling of 2026-08-13
// on #2654. It is not a local choice: the argument lives with the exemption in
// lib/micro-motion.ts's MICRO_MOTION_BAND_EXEMPTIONS, which cannot be written without
// one, and it exempts this pulse alone.
export default function FoldSummary({
  count,
  className,
}: {
  // The authoritative number of snoozed + dismissed rows behind this disclosure.
  count: number;
  className: string;
}) {
  const reduced = usePrefersReducedMotion();
  const plan = microMotionPlan("fold", reduced);
  const [pulsing, setPulsing] = useState(false);
  // The count we last DREW — compared against the prop so the effect fires on a real
  // change and not on every re-render of the page around it.
  const drawn = useRef(count);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `reduced` is a dependency so the effect always reads the CURRENT preference; the
  // identity guard on the first line means flipping the preference on its own pulses
  // nothing, it only decides how the NEXT increment is drawn.
  useEffect(() => {
    const previous = drawn.current;
    if (count === previous) return;
    drawn.current = count;
    // Only an increment. A Restore takes a row back OUT of the fold, and the fold has
    // nothing to say about that.
    if (count < previous || !plan.animate) return;
    if (timer.current) clearTimeout(timer.current);
    setPulsing(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setPulsing(false);
    }, plan.ms);
  }, [count, plan.animate, plan.ms, reduced]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return (
    <summary
      data-testid="suppressed-summary"
      data-motion="fold"
      data-reduced-motion={reduced ? "true" : "false"}
      data-pulsing={pulsing ? "true" : "false"}
      // `rounded-lg` so the box-shadow ring follows the line rather than boxing it;
      // it changes no geometry, which is the rule the whole vocabulary keeps.
      className={`${className} rounded-lg${pulsing ? " motion-fold" : ""}`}
    >
      Snoozed &amp; dismissed{" "}
      <span
        data-testid="suppressed-count"
        className="tabular-nums text-slate-500 dark:text-slate-400"
      >
        ({count})
      </span>
    </summary>
  );
}
