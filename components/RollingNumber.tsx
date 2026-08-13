"use client";

import { useEffect, useRef, useState } from "react";
import { countRollValue, microMotionPlan } from "@/lib/micro-motion";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

// A day counter that ROLLS when its quantity changes (#2654, motion 3).
//
// A quantity changing reads differently from a value being replaced, and that
// difference IS the information: after a one-tap log the number travels from the old
// total to the new one over 250 ms with one subtle scale pulse, so the tap's
// consequence is visible in the number itself instead of only in a toast.
//
// The contract, in the order it matters:
//
//  * THE FINAL VALUE IS ALWAYS THE TRUTH IN THE DOM. `value` renders verbatim on the
//    server, on the first client paint, and on every mount. The roll only ever plays
//    on a CHANGE, so a screen reader, a no-JS reader and an exact-text assertion all
//    read the real number, never a frame of a tween.
//  * Reduced motion is the designed state, not a fallback: the new number is simply
//    there. `microMotionPlan` returns 0 ms, no rAF loop is started, and no pulse
//    class is applied. Published as `data-reduced-motion` so the browser suite can
//    prove the branch was taken without asserting on a duration.
//  * `tabular-nums` is not optional and is applied here rather than by the caller —
//    digits that change width relayout the row around them, which is the one thing
//    this motion must not do (motion never delays or displaces the next tap).
//  * Nothing loops. One animation per change, cancelled if another change lands.
//
// NOT `components/CountUpNumber.tsx`, which is the other tenancy: a dashboard hero
// number ticking up ONCE on mount and explicitly never replaying. This one never
// plays on mount and only ever plays on a change. Two different sentences.
export default function RollingNumber({
  value,
  format,
  className,
  testId,
}: {
  // The authoritative quantity. Rendered as-is on mount; a change rolls to it.
  value: number;
  // How the number reads. Defaults to the integer, with the locale PINNED for the
  // repo's date/number-locale guard and so SSR and hydration agree byte for byte.
  format?: (n: number) => string;
  className?: string;
  testId?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  const [rolling, setRolling] = useState(false);
  // The last value we were ASKED for — compared against `value` so the effect fires
  // on a real change and not on every re-render of the parent.
  const target = useRef(value);

  // `reduced` is a dependency so the effect always reads the CURRENT preference, and
  // the identity guard on the first line means a preference flip on its own restarts
  // nothing — it only decides how the NEXT change is drawn.
  useEffect(() => {
    if (value === target.current) return;
    const from = target.current;
    target.current = value;
    const { ms, animate } = microMotionPlan("count", reduced);
    if (!animate || ms <= 0 || from === value) {
      // The reduced-motion design, and the degenerate case: the number is there.
      setShown(value);
      setRolling(false);
      return;
    }
    setRolling(true);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      setShown(countRollValue(from, value, elapsed, ms));
      if (elapsed < ms) {
        frame = requestAnimationFrame(tick);
        return;
      }
      setRolling(false);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      // A second change mid-roll settles the first one honestly rather than
      // abandoning it on whatever frame it reached.
      setShown(value);
      setRolling(false);
    };
  }, [value, reduced]);

  return (
    <span
      data-testid={testId}
      data-motion="count"
      data-reduced-motion={reduced ? "true" : "false"}
      data-rolling={rolling ? "true" : "false"}
      className={`tabular-nums${rolling ? " motion-count" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {format ? format(shown) : shown.toLocaleString("en-US")}
    </span>
  );
}
