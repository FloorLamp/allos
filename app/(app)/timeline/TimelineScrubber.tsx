"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppRoute } from "@/lib/hrefs";
import { useHaptics } from "@/components/useHaptics";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { microMotionPlan } from "@/lib/micro-motion";
import {
  scrubberFraction,
  scrubberRelease,
  scrubberScrollTop,
  scrubberTickAt,
  scrubberTickAtScroll,
  scrubberTickFractions,
  type ScrubberTick,
} from "@/lib/timeline-scrubber";

// THE JUMP RAIL (issue #2657 item 4) — the browser half. Every decision it makes is
// imported from lib/timeline-scrubber.ts; what lives here is measurement, pointer
// plumbing and paint.
//
// The idiom is the photo app's, by owner ruling: a slim strip down the right edge,
// NO TEXT AT REST — month dots and the heavier year marks, nothing else — and a
// floating bubble that names the period under the finger only while a drag is live.
//
// THREE THINGS ARE LOAD-BEARING AND EACH IS EASY TO GET WRONG.
//
// 1. A DRAG AND A TAP ARE DIFFERENT GESTURES WITH DIFFERENT POWERS. Releasing a drag
//    only positions the scroll. A plain tap jumps to the period and EXPANDS it on
//    arrival. So scrubbing can never mutate open/closed state, and a reader dragging
//    past eleven months does not arrive with eleven months unfolded. `scrubberRelease`
//    is the whole distinction and it is travel-based, never duration-based: a slow,
//    hesitant tap is still a tap.
//
// 2. THE HIT AREA IS 44px WIDE AND THE VISUAL IS ~5px. Decoupled deliberately — the
//    platform touch-target floor against a hairline that must not become chrome. The
//    consequence is that the strip sits over 44px of the feed's own right edge, which
//    would swallow taps on the event cards underneath, so the FEED gives up a gutter
//    of exactly that width whenever the rail renders (see page.tsx). The rail owns the
//    gutter; it does not squat on the content.
//
// 3. CROSSING A MONTH BOUNDARY IS FEEDBACK, AND ITS TWO CHANNELS ARE NOT EQUAL. The
//    bubble beats (MICRO_MOTIONS.tick) and one 8 ms haptic fires where the platform
//    has one. iOS ships no web Vibration API, so on a large share of the phones this
//    rail exists for the beat is the ONLY non-textual feedback there is — which is why
//    the visual is the universal channel and the haptic is the enhancement, not the
//    other way round. The iOS 17.4+ `<input type="checkbox" switch>` haptic trick is
//    deliberately NOT used: it is unspecified behaviour Apple can remove, and buying a
//    buzz with a hidden form control that assistive technology can see is a bad trade
//    for a cue the bubble already carries.
//
// ACCESSIBILITY. The rail is SUPPLEMENTARY — the month cards are the keyboard and AT
// path, and they are plain links that work before this component hydrates. It still
// carries `role="slider"` with `aria-valuetext` naming the period, per the ruling, and
// it is genuinely operable from the keyboard rather than a slider in name only:
// arrows/Home/End POSITION (a drag), Enter/Space JUMPS AND EXPANDS (a tap). A role that
// announces a value nobody can move would be worse than no role.

export interface ScrubberStop extends ScrubberTick {
  /**
   * Where a TAP navigates when this period's content is folded away — the fold toggle
   * plus the anchor. Null when everything under the stop is already rendered, which
   * makes the tap a pure in-page scroll: no navigation, no history entry, and nothing
   * added to `?open=`.
   */
  href: AppRoute | null;
}

function scrollRangeNow(): number {
  return Math.max(
    0,
    document.documentElement.scrollHeight - window.innerHeight
  );
}

export default function TimelineScrubber({ stops }: { stops: ScrubberStop[] }) {
  const router = useRouter();
  const fire = useHaptics();
  const reduceMotion = usePrefersReducedMotion();
  const pulsePlan = microMotionPlan("tick", reduceMotion);

  const stripRef = useRef<HTMLDivElement>(null);
  const [fractions, setFractions] = useState<number[]>([]);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [bubbleTop, setBubbleTop] = useState(0);
  // Bumped on every boundary crossing. It is the bubble's React `key`, so the node is
  // replaced and the one-shot beat replays — a class toggle would only animate once.
  const [beat, setBeat] = useState(0);

  // Refs shadow the state the pointer path reads mid-gesture: a handler that closed
  // over last render's `active` would fire a second haptic for a boundary it already
  // crossed, and one that closed over `dragging` would let the scroll listener fight
  // the finger.
  const activeRef = useRef(0);
  const draggingRef = useRef(false);
  const movedRef = useRef(0);
  const startYRef = useRef(0);
  const rangeRef = useRef(0);
  const offsetsRef = useRef<number[]>([]);
  const fractionsRef = useRef<number[]>([]);

  // The anchors this rail points at, as a value that only changes when the SERVER
  // rendered a different feed. Expansion is URL state, so an expand/collapse is a new
  // document with new anchors and new heights — which is exactly the "recomputed on
  // every expand/collapse" clause, discharged by re-running this effect rather than by
  // watching for a toggle.
  const signature = stops.map((s) => `${s.key}@${s.anchorId}`).join("|");

  const measure = useCallback(() => {
    rangeRef.current = scrollRangeNow();
    const offsets = stops.map((stop) => {
      const el = document.getElementById(stop.anchorId);
      // An anchor the feed did not render is a stop that should not exist; the pure
      // side falls back to even spacing rather than throwing the measurement away.
      if (!el) return Number.NaN;
      return el.getBoundingClientRect().top + window.scrollY;
    });
    offsetsRef.current = offsets;
    const next = scrubberTickFractions(offsets);
    fractionsRef.current = next;
    setFractions(next);
    // `signature` IS `stops`' value identity — the server hands back a fresh array on
    // every render, so depending on the array itself would re-measure the whole
    // document on every keystroke of state this component owns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    // Fonts, images and late layout move every anchor. One observer on the document
    // element catches all of it without a timer — and it delivers an initial callback
    // when observation starts, which is the FIRST measurement. Measuring synchronously
    // in the effect body would be a cascading render for a number the observer is
    // about to hand us anyway.
    const observer = new ResizeObserver(() => measure());
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
    };
  }, [measure]);

  // At rest the rail still has a value: the period currently at the top of the
  // viewport. Without this the slider would announce whatever the last drag left
  // behind, which is a lie the moment the reader scrolls with a finger or a wheel.
  useEffect(() => {
    const onScroll = () => {
      if (draggingRef.current) return;
      // Asked of the OFFSETS, not of a strip fraction: the strip's coordinate system
      // is the span between the stops, and a scroll position is not in it.
      const index = scrubberTickAtScroll(offsetsRef.current, window.scrollY);
      if (index >= 0 && index !== activeRef.current) {
        activeRef.current = index;
        setActive(index);
      }
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [fractions]);

  const selectAt = useCallback(
    (index: number, opts: { feedback: boolean }) => {
      if (index < 0 || index === activeRef.current) return;
      activeRef.current = index;
      setActive(index);
      if (!opts.feedback) return;
      setBeat((n) => n + 1);
      fire("scrubber-tick");
    },
    [fire]
  );

  const trackPointer = useCallback(
    (clientY: number, scroll: boolean) => {
      const strip = stripRef.current;
      if (!strip) return;
      const rect = strip.getBoundingClientRect();
      const fraction = scrubberFraction(clientY, rect.top, rect.height);
      setBubbleTop(rect.top + fraction * rect.height);
      selectAt(scrubberTickAt(fractionsRef.current, fraction), {
        feedback: true,
      });
      if (scroll) {
        // `instant`: the page must track the finger. A smooth scroll here would
        // queue animations behind a gesture that is already somewhere else.
        window.scrollTo({
          top: scrubberScrollTop(
            fraction,
            offsetsRef.current,
            rangeRef.current
          ),
          behavior: "instant",
        });
      }
    },
    [selectAt]
  );

  const jumpTo = useCallback(
    (index: number) => {
      const stop = stops[index];
      if (!stop) return;
      // Folded away → a real navigation that toggles `?open=` and lands on the anchor.
      // Already rendered → an in-page scroll, so a tap on this month never grows the
      // URL or the back stack.
      if (stop.href) {
        router.push(stop.href);
        return;
      }
      document.getElementById(stop.anchorId)?.scrollIntoView({
        block: "start",
        behavior: reduceMotion ? "auto" : "smooth",
      });
    },
    [reduceMotion, router, stops]
  );

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    // A drag has already positioned the scroll and is finished. Only a tap acts.
    if (scrubberRelease(movedRef.current) === "tap") jumpTo(activeRef.current);
  }, [jumpTo]);

  const activeStop = stops[active] ?? stops[0];

  return (
    <>
      <div
        ref={stripRef}
        data-testid="timeline-scrubber"
        data-scrubber-dragging={dragging ? "true" : "false"}
        // The rail cannot answer anything before it has measured the feed's anchors —
        // the first paint is server HTML with no geometry in it, and a drag landing in
        // that window would scrub against an empty stop space. Declared rather than
        // inferred, so a browser test waits on the state instead of on a duration.
        data-scrubber-ready={fractions.length > 0 ? "true" : "false"}
        role="slider"
        tabIndex={0}
        aria-label="Scrub to a month"
        title="Scrub to a month"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, stops.length - 1)}
        aria-valuenow={active}
        aria-valuetext={activeStop?.valueText ?? ""}
        // w-11 is the 44px touch floor; `touch-none` stops the browser turning a
        // scrub into a native page scroll before a pointermove ever arrives. The strip
        // starts below the sticky filter block and runs to just above the mobile dock,
        // and it deliberately sits ABOVE everything in that column — which is only
        // safe because the two surfaces it overlaps (the filter block and the feed)
        // both give up a gutter of exactly this width. Losing the stacking contest
        // instead would leave the rail with a dead zone at the top of the page, which
        // is the half-measure this replaced.
        className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-0 top-20 z-20 w-11 touch-none select-none outline-none focus-visible:bg-brand-500/5 md:bottom-8 md:top-44 print:hidden"
        onPointerDown={(event) => {
          if (fractionsRef.current.length === 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          draggingRef.current = true;
          setDragging(true);
          movedRef.current = 0;
          startYRef.current = event.clientY;
          // Zeroed per gesture, so `beat > 0` means "this drag has crossed a boundary".
          // The bubble APPEARING is not a crossing and must not beat: the ruling gives
          // the pulse one meaning, and a beat on arrival would spend it on nothing.
          setBeat(0);
          trackPointer(event.clientY, true);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          movedRef.current = Math.max(
            movedRef.current,
            Math.abs(event.clientY - startYRef.current)
          );
          trackPointer(event.clientY, true);
        }}
        onPointerUp={endDrag}
        onPointerCancel={() => {
          // A cancelled gesture never happened: no jump, no expand.
          draggingRef.current = false;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          const last = stops.length - 1;
          let next: number | null = null;
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            next = Math.min(last, active + 1);
          } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            next = Math.max(0, active - 1);
          } else if (event.key === "Home") {
            next = 0;
          } else if (event.key === "End") {
            next = last;
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            jumpTo(active);
            return;
          }
          if (next == null) return;
          event.preventDefault();
          selectAt(next, { feedback: true });
          // Arrows POSITION, exactly as a drag does — they never expand. Enter is the
          // keyboard's tap.
          document.getElementById(stops[next].anchorId)?.scrollIntoView({
            block: "start",
            behavior: reduceMotion ? "auto" : "smooth",
          });
        }}
      >
        {stops.map((stop, index) => {
          const heavy = stop.kind === "year" || stop.yearMark;
          return (
            <span
              key={stop.key}
              data-testid={`timeline-scrubber-tick-${stop.key}`}
              data-scrubber-active={index === active ? "true" : undefined}
              aria-hidden
              className={`absolute right-1.5 h-px rounded-full ${
                heavy
                  ? "w-4 bg-slate-500/70 dark:bg-slate-300/60"
                  : "w-1.5 bg-slate-400/60 dark:bg-slate-500/70"
              }`}
              style={{ top: `${(fractions[index] ?? 0) * 100}%` }}
            />
          );
        })}
      </div>

      {/* The bubble exists only while a drag is live — "at rest, no text" is the whole
          point of the idiom, and a permanent label would make the rail chrome. It is
          `aria-hidden` because the same words are already the slider's own
          `aria-valuetext`, and announcing them twice is worse than once. */}
      {dragging && activeStop && (
        <div
          data-testid="timeline-scrubber-bubble"
          aria-hidden
          className="pointer-events-none fixed right-12 z-30 -translate-y-1/2 print:hidden"
          style={{ top: bubbleTop }}
        >
          <span
            key={beat}
            className={`block rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold tracking-wide text-white shadow-lg dark:bg-slate-100 dark:text-slate-900 ${beat > 0 ? pulsePlan.className : ""}`}
          >
            {activeStop.label}
          </span>
        </div>
      )}
    </>
  );
}
