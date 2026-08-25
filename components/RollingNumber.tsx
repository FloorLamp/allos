"use client";

import { useEffect, useState } from "react";
import { microMotionPlan } from "@/lib/micro-motion";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

// A day counter that ROLLS when its quantity changes (#2654, motion 3).
//
// A quantity changing reads differently from a value being replaced, and that
// difference IS the information: after a one-tap log the authoritative new number
// lands immediately and receives one subtle 250 ms scale pulse, so the tap's
// consequence is visible in the number itself instead of only in a toast.
//
// The contract, in the order it matters:
//
//  * THE FINAL VALUE IS ALWAYS THE TRUTH IN THE DOM. `value` renders verbatim on the
//    server, on the first client paint, and on every mount. The roll only ever plays
//    on a CHANGE, so a screen reader, a no-JS reader and an exact-text assertion all
//    read the real number. The visual receipt may wait for a paint; truth never does.
//  * Reduced motion is the designed state, not a fallback: the new number is simply
//    there. `microMotionPlan` returns 0 ms, no rAF loop is started, and no pulse
//    class is applied. Published as `data-reduced-motion` so the browser suite can
//    prove the branch was taken without asserting on a duration.
//  * `tabular-nums` is not optional and is applied here rather than by the caller —
//    digits that change width relayout the row around them, which is the one thing
//    this motion must not do (motion never delays or displaces the next tap).
//  * Nothing loops. One animation per change, cancelled if another change lands.
//
// This motion never plays on mount and only ever plays on a change.
export default function RollingNumber({
  value,
  format,
  className,
  testId,
}: {
  // The authoritative quantity. Rendered as-is on mount and every change.
  value: number;
  // How the number reads. Defaults to the integer, with the locale PINNED for the
  // repo's date/number-locale guard and so SSR and hydration agree byte for byte.
  format?: (n: number) => string;
  className?: string;
  testId?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [receipt, setReceipt] = useState({
    target: value,
    rolling: false,
    runs: 0,
  });
  if (receipt.target !== value) {
    const plan = microMotionPlan("count", reduced);
    const animate = plan.animate && plan.ms > 0;
    // React's documented adjust-state-during-render pattern: this rerenders before
    // children commit, so the receipt joins the authoritative value's own paint.
    // Unlike the removed `shown` state, this stores no health value — only whether
    // its bounded visual acknowledgement is active.
    setReceipt({
      target: value,
      rolling: animate,
      runs: receipt.runs + (animate ? 1 : 0),
    });
  }

  // `value` itself renders below, so this effect schedules only the bounded pulse
  // receipt, never displayed truth. A preference flip alone restarts nothing.
  useEffect(() => {
    if (!receipt.rolling) return;
    const { ms } = microMotionPlan("count", false);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed < ms) {
        frame = requestAnimationFrame(tick);
        return;
      }
      setReceipt((current) =>
        current.target === receipt.target
          ? { ...current, rolling: false }
          : current
      );
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      // A second change cancels the old receipt; its own pulse is already the
      // current render state. The rendered `value` remains independent.
    };
  }, [receipt.rolling, receipt.target]);

  return (
    <span
      data-testid={testId}
      data-motion="count"
      data-reduced-motion={reduced ? "true" : "false"}
      data-rolling={receipt.rolling ? "true" : "false"}
      data-motion-runs={receipt.runs}
      className={`tabular-nums${receipt.rolling ? " motion-count" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {format ? format(value) : value.toLocaleString("en-US")}
    </span>
  );
}
