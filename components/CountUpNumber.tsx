"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

/** Count-up duration. The one "delight" animation the chart layer keeps
 *  (issue #1445, Part 3c) — long enough to read as a tick-up, short enough that
 *  a returning glance never waits on it. */
export const COUNT_UP_MS = 400;

/**
 * A dashboard hero number that ticks up to its value ONCE on mount.
 *
 * Deliberate constraints, in a medical-data app where motion has to carry
 * meaning rather than decorate:
 *
 * - The FINAL value is what renders on the server and on the very first client
 *   paint. The animation is a client-only embellishment layered on afterwards,
 *   so a no-JS reader, a screen reader, and anything that reads the DOM before
 *   hydration all see the true number — never a zero, never a partial count.
 * - Once. It does not replay when the value changes (a fresh sync nudging the
 *   step count must not restart a 400ms count-up under the reader's eyes).
 * - `prefers-reduced-motion: reduce` skips it entirely — the value simply sits
 *   there, which is what it does after 400ms anyway.
 *
 * NOT a general-purpose number wrapper: it is for a hero COUNT (a magnitude
 * whose ticking-up is meaningful). Don't wrap a value an exact-text assertion
 * or a live-region announcement reads.
 */
export default function CountUpNumber({
  value,
  fallback = "—",
  className,
  testId,
}: {
  /** The final value. Null renders `fallback` with no animation. */
  value: number | null;
  /** Rendered when `value` is null. */
  fallback?: string;
  className?: string;
  testId?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState<number | null>(value);
  const played = useRef(false);
  const settled = useRef(value);

  // `usePrefersReducedMotion` resolves its media query AFTER mount (defaulting
  // false so SSR and the first client render agree), so the count-up waits one
  // tick for the real answer rather than starting a 400ms tick-up under someone
  // who asked for no motion and cancelling it a frame later.
  const [resolved, setResolved] = useState(false);
  useEffect(() => setResolved(true), []);

  useEffect(() => {
    if (!resolved || played.current || reduced || value == null || value <= 0)
      return;
    played.current = true;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      // ease-out cubic: fast off the mark, settling onto the real number.
      const eased = 1 - (1 - t) ** 3;
      setShown(t >= 1 ? value : Math.round(value * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // Mount-only by design: `value` is read once, and `played` guards a replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, reduced]);

  // Keep the displayed number honest if the value itself CHANGES later (a
  // re-fetch, a profile switch) — snap to it, never re-animate. Compared against
  // the last settled value so this doesn't fire on mount and cancel the count-up.
  useEffect(() => {
    if (value === settled.current) return;
    settled.current = value;
    setShown(value);
  }, [value]);

  return (
    <span className={className} data-testid={testId}>
      {/* Thousands separators only, with the locale PINNED — the repo's
          date-locale guard (#964/#1020) requires the literal, and it also keeps
          the SSR and client renders byte-identical. Formatting lives here rather
          than in a `format` prop because every caller is a Server Component, and
          a function crossing that boundary is a hard render error. */}
      {shown == null ? fallback : shown.toLocaleString("en-US")}
    </span>
  );
}
