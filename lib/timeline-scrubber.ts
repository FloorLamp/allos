// THE TIMELINE JUMP RAIL (issue #2657 item 4) — PURE, no DOM, no React, no clock.
//
// Items 1–3 and 6 folded /timeline's 47,000px of unrolled history into a spine: the
// future to one line, the last 14 days event-grained, older months to one card each,
// earlier years to one card each. The spine is short, and that is exactly what makes a
// RAIL worth having — a five-year profile is now a scrollable list of periods, and a
// reader who wants August 2025 should not have to hunt for its card.
//
// The decided idiom is the photo-app scrubber (owner ruling on #2657, "Scrubber spec
// (decided)"), not a labeled button column: a slim right-edge strip, no text at rest,
// a floating bubble naming the period under the finger during a drag. This module is
// the half of it that can be decided without a browser, which is most of it:
//
//   • WHICH periods the strip offers (`timelineScrubberTicks`) — the tick set,
//   • WHERE each one sits on the strip (`scrubberTickFractions`),
//   • WHICH one a pointer at a given position names (`scrubberTickAt`),
//   • WHERE a drag scrolls to (`scrubberScrollTop`),
//   • WHETHER a released pointer was a tap or a drag (`scrubberRelease`).
//
// The component measures (strip box, document scroll range, anchor offsets) and
// paints; it decides nothing.
//
// ── THE TICK SET IS WHAT IS REACHABLE BY SCROLL ─────────────────────────────
//
// The ruling's sharpest clause: "months hidden inside a collapsed year card leave the
// tick set, so no phantom ticks fire for content that isn't reachable by scroll." A
// tick is a promise that dragging here lands you somewhere; a tick for a month whose
// card is not in the document is a promise the rail cannot keep, and the bubble would
// name a period the page is not showing. So the set is derived from the WINDOWED feed
// (which already knows what is rendered), never from the raw day list, and it is
// recomputed on every expand/collapse for free — expansion is URL state (#2657's
// windowing), so an expand is a fresh server render with a fresh tick set.
//
// ONE TICK PER CALENDAR MONTH, not one per rendered band. A month can be split across
// two bands: with today on the 8th, the recent 14 days reach back into last month
// while last month's earlier days sit in its fold card. That is one period the reader
// thinks of by one name, so it is one dot — anchored at the TOPMOST place that month
// appears (the recent day group), and carrying the fold key of the half that is still
// collapsed, so the tap opens it. Two adjacent dots both saying "JUL 2026" would read
// as a bug, and would be one.
//
// THE AHEAD FOLD GETS NO TICK, deliberately. The strip scrubs HISTORY. "Scheduled
// ahead" exists precisely to demote speculative scheduling out of the reader's entry
// point (item 1), and making it the rail's first stop would re-promote it. It is one
// line at the very top of the feed, above the first tick, and dragging to the top of
// the strip still lands on the top of the page — where it is.
//
// ── THE MAPPING IS TO SCROLL SPACE, AND THE DOTS PROVE IT ───────────────────
//
// "Maps to the current scroll space" could have meant two things, and the difference
// is a defect. Positioning dots EVENLY and selecting them by nearest-dot makes the
// strip a menu, and dragging then lies: the finger is a third of the way down, the
// page jumps to a period that is 80% of the way down. So a dot sits at its anchor's
// own fraction of the scroll range, and the tick under the finger is the last dot AT
// OR ABOVE the finger. Dot placement and finger selection read the same array, so
// "the period I get is the dot I am pointing at" is true by construction rather than
// by two functions agreeing.
//
// Fractions are CLAMPED into [0, 1] rather than dropped. An anchor can legitimately
// sit past the maximum scroll position — the last month's card, with less than a
// viewport of content under it, can never reach the top of the window — and a tick
// that no drag can select is a period the rail silently refuses to offer. Clamped, it
// pins to the bottom of the strip, which is where dragging to the bottom takes you.
//
// A DOCUMENT THAT DOES NOT SCROLL still gets a rail with usable stops: with no scroll
// range there is no proportion to honour, so the dots space evenly and every tap still
// lands. This is the degenerate case (an expanded feed short enough to fit), not a
// second mapping to keep in sync — `scrubberTickFractions` owns both.

import type { TimelineWindowed, WindowableDay } from "./timeline-window";
import { MONTHS_SHORT } from "./date";
import { timelineMonthLabel, timelineMonthKey } from "./timeline-window";

/**
 * The pointer/touch target's width in CSS pixels. The platform touch-target floor,
 * and deliberately decoupled from the ~5px visual: the dots are a hairline, the strip
 * you can actually hit is the whole edge. The component owns the gutter that keeps
 * this strip from sitting on top of the feed's own tap targets.
 */
export const SCRUBBER_HIT_WIDTH_PX = 44;

/**
 * How far a pointer may travel and still count as a TAP. Above it the gesture was a
 * drag, and a drag only positions the scroll — it never expands anything.
 */
export const SCRUBBER_TAP_SLOP_PX = 8;

/**
 * Below this many stops the rail is not offered. Not a height heuristic — a feed with
 * one period has nothing to scrub between, and a permanent strip down the edge of a
 * short page is chrome charging rent for nothing.
 */
export const SCRUBBER_MIN_TICKS = 2;

/** One stop on the rail: a period the reader can jump to. */
export interface ScrubberTick {
  /** Stable identity. A month's `YYYY-MM`, or a collapsed year's `YYYY`. */
  key: string;
  /** `month` draws a dot; `year` draws the heavier year mark. */
  kind: "month" | "year";
  /** What the drag bubble shows: "MAR 2026" / "2025". Terse, uppercase, no text at rest. */
  label: string;
  /**
   * What `aria-valuetext` announces. Spelled OUT — "March 2026" — because "MAR" is a
   * visual shorthand and a screen reader saying "M-A-R" is not a period name.
   */
  valueText: string;
  /** The element id in the feed a jump scrolls to. */
  anchorId: string;
  /**
   * The `?open=` fold key a TAP must toggle to reveal this period's content, or null
   * when everything under this tick is already rendered. Non-null only for a fold the
   * feed rendered CLOSED, so toggling it can only ever open.
   */
  openKey: string | null;
  /** The 4-digit year this period belongs to. */
  year: string;
  /**
   * True on the first tick of each year. The strip draws a longer, heavier mark here
   * — never the digits: "at rest, no text" is the idiom's whole point, and a column of
   * years down the edge of every timeline is the labeled button rail the ruling
   * rejected. The digits are the bubble's job, during a drag.
   */
  yearMark: boolean;
}

/** "2026-03" → "MAR 2026". A key that is not a real month renders itself. */
export function scrubberMonthLabel(key: string): string {
  const month = MONTHS_SHORT[Number(key.slice(5, 7)) - 1];
  return month ? `${month.toUpperCase()} ${key.slice(0, 4)}` : key;
}

interface Stop {
  key: string;
  kind: "month" | "year";
  anchorId: string;
  openKey: string | null;
}

/**
 * The rail's stops, in FEED ORDER (top of the page first, so newest first). Derived
 * entirely from what the windowed feed rendered:
 *
 *   • every calendar month with days in the recent band, anchored on its newest day
 *     group and carrying the fold key of its older half when that half is collapsed;
 *   • every month card of the current year, anchored on the card;
 *   • a CLOSED year: one year mark, anchored on the year card — its months are not in
 *     the document and must not be in the tick set;
 *   • an OPEN year: its month cards, exactly as the current year's.
 *
 * The ahead fold contributes nothing (see the module header).
 */
export function timelineScrubberTicks<D extends WindowableDay>(
  windowed: TimelineWindowed<D>
): ScrubberTick[] {
  const order: Stop[] = [];
  const byKey = new Map<string, Stop>();

  const push = (stop: Stop): void => {
    order.push(stop);
    byKey.set(stop.key, stop);
  };

  for (const day of windowed.recent) {
    const key = timelineMonthKey(day.date);
    if (byKey.has(key)) continue;
    push({
      key,
      kind: "month",
      anchorId: `timeline-day-${day.date}`,
      openKey: null,
    });
  }

  const monthStop = (month: { key: string; open: boolean }): void => {
    const existing = byKey.get(month.key);
    if (existing) {
      // The straddled month: its newest days are already in the recent band, so it
      // already has a dot. What the fold adds is the older half — and if that half is
      // shut, the dot's tap has to open it.
      if (!month.open) existing.openKey = month.key;
      return;
    }
    push({
      key: month.key,
      kind: "month",
      anchorId: `timeline-fold-${month.key}`,
      openKey: month.open ? null : month.key,
    });
  };

  for (const month of windowed.months) monthStop(month);

  for (const year of windowed.years) {
    if (!year.open) {
      push({
        key: year.key,
        kind: "year",
        anchorId: `timeline-fold-${year.key}`,
        openKey: year.key,
      });
      continue;
    }
    for (const month of year.months) monthStop(month);
  }

  let previousYear: string | null = null;
  return order.map((stop) => {
    const year = stop.key.slice(0, 4);
    const yearMark = year !== previousYear;
    previousYear = year;
    return {
      key: stop.key,
      kind: stop.kind,
      label: stop.kind === "year" ? stop.key : scrubberMonthLabel(stop.key),
      valueText: stop.kind === "year" ? stop.key : timelineMonthLabel(stop.key),
      anchorId: stop.anchorId,
      openKey: stop.openKey,
      year,
      yearMark,
    };
  });
}

/** Whether the rail is worth rendering at all. */
export function showTimelineScrubber(ticks: readonly unknown[]): boolean {
  return ticks.length >= SCRUBBER_MIN_TICKS;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Where each tick's dot sits on the strip, 0 (top) … 1 (bottom).
 *
 * `offsets` are the anchors' document offsets, measured by the component, in the same
 * order as the ticks. `scrollRange` is `scrollHeight - innerHeight`: the distance the
 * document can actually travel.
 *
 * With no scroll range there is no proportion to honour, so the stops space evenly —
 * the degenerate case, owned here rather than branched around by the caller.
 */
export function scrubberTickFractions(
  offsets: readonly number[],
  scrollRange: number
): number[] {
  if (offsets.length === 0) return [];
  if (offsets.length === 1) return [0];
  if (!(scrollRange > 0)) {
    const last = offsets.length - 1;
    return offsets.map((_, index) => index / last);
  }
  return offsets.map((offset) => clamp01(offset / scrollRange));
}

/**
 * The index of the tick a pointer at `fraction` of the strip names: the last stop at
 * or above the finger. -1 when there are none.
 *
 * Ties go to the LAST matching stop, which is what makes the clamped bottom work — a
 * run of trailing months pinned to 1 is selected by dragging to the bottom, and the
 * one you get is the deepest, the one no other gesture could reach.
 */
export function scrubberTickAt(
  fractions: readonly number[],
  fraction: number
): number {
  if (fractions.length === 0) return -1;
  const at = clamp01(fraction);
  let index = 0;
  for (let i = 0; i < fractions.length; i++) {
    if (fractions[i] <= at) index = i;
  }
  return index;
}

/** A pointer's y, as a clamped fraction of the strip's box. */
export function scrubberFraction(
  pointerY: number,
  stripTop: number,
  stripHeight: number
): number {
  if (!(stripHeight > 0)) return 0;
  return clamp01((pointerY - stripTop) / stripHeight);
}

/** Where a drag at `fraction` puts the document. */
export function scrubberScrollTop(
  fraction: number,
  scrollRange: number
): number {
  if (!(scrollRange > 0)) return 0;
  return clamp01(fraction) * scrollRange;
}

/**
 * What a released pointer meant. "Releasing a drag only positions the scroll. A plain
 * tap jumps to that month and expands it on arrival" — so this is the whole difference
 * between a gesture that may mutate `?open=` and one that may not, and it is decided
 * by travel alone. Not by duration: a slow, careful tap is still a tap, and a reader
 * resting a thumb on the rail before committing must not have their history expanded
 * out from under them for hesitating.
 */
export function scrubberRelease(movedPx: number): "tap" | "drag" {
  return Math.abs(movedPx) <= SCRUBBER_TAP_SLOP_PX ? "tap" : "drag";
}
