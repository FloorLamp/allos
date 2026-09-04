import { INTRADAY_BUCKET_MINUTES } from "./intraday";
import { MIN_ZOOM_MINUTES } from "./intraday-layout";

// THE DAY CHART'S SELECTED WINDOW, AS A URL PARAM AND BACK (#4950).
//
// A drag on the day chart while the add row is armed states a window — "the sauna was
// 19:10 to 20:40" — and the add door's forms open on it. `app/(app)/history/page.tsx`
// and `components/IntradayPanel.tsx` are SERVER components, so the window cannot ride a
// React callback from the chart to the door at all; it rides `historyHref`'s `?from=` /
// `?to=`, and this module is the one place that turns those two strings into minutes and
// refuses the pairs that are not a window.
//
// WHY NOT `hhmmToMinutes`. That decoder folds malformed input to 0 on purpose — every
// one of its callers is a time-window comparison where NaN would silently disable the
// window, so a wrong answer is safer there than no answer. Here the opposite is true: a
// `?from=lunchtime` that reads as 00:00 opens a form prefilled with midnight and nothing
// says it was invented. This parser refuses instead, and the two live side by side
// because they are answering different questions rather than duplicating one.
//
// NEVER REPAIRED. An inverted pair, a span under the chart's own minimum, a clock
// outside the day — each drops the WHOLE window rather than being nudged into range. A
// repaired window is a time the person did not state, presented in a form they are about
// to submit, and the only honest recoveries are "what you selected" or "nothing".

/** A window on the day in view, in minutes since profile-local midnight. */
export interface IntradayWindow {
  from: number;
  /** Null when the person marked a start alone — a tap rather than a drag. */
  to: number | null;
}

const MINUTES_IN_DAY = 24 * 60;
// `HH:MM`, 24-hour, both fields two digits. Deliberately stricter than the clocks the
// app PRINTS: this is a machine-written param round-tripping through a URL, so the one
// spelling the writer emits is the only one the reader has to accept.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` → minutes since midnight, or null when it is not that shape. */
export function parseClockMinute(value: string | undefined): number | null {
  if (!value) return null;
  const m = HHMM.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes since midnight → `HH:MM`, the spelling `parseClockMinute` accepts. */
export function formatClockMinute(minute: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_IN_DAY - 1, Math.round(minute)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Snap to the chart's own bucket, so a window states a time the chart can draw.
 *
 * NEAREST rather than floor: the person is pointing at a place on a trace, and moving
 * their mark up to two minutes earlier is no more honest than moving it later. The
 * chart's plot is bucketed at `INTRADAY_BUCKET_MINUTES` anyway, so an unsnapped clock
 * would draw a selection edge that does not line up with the reading beneath it.
 *
 * The ceiling is the last BUCKET, not the last minute: 23:59 rounds up to 24:00, which
 * is the next day's midnight, and clamping that to 23:59 would return a clock that is
 * not on a bucket — a value this function's own contract says it never emits.
 */
const LAST_BUCKET = MINUTES_IN_DAY - INTRADAY_BUCKET_MINUTES;
export function snapToBucket(minute: number): number {
  const snapped =
    Math.round(minute / INTRADAY_BUCKET_MINUTES) * INTRADAY_BUCKET_MINUTES;
  return Math.max(0, Math.min(LAST_BUCKET, snapped));
}

/**
 * The window a `?from=` / `?to=` pair states, or null when it states none.
 *
 * SNAP FIRST, THEN JUDGE. The minimum span is checked on the snapped values, because
 * the snapped values are what the chart draws and what the form receives — judging the
 * raw pair would admit a window whose drawn form is shorter than the minimum.
 */
export function parseIntradayWindow(
  from: string | undefined,
  to: string | undefined
): IntradayWindow | null {
  const rawFrom = parseClockMinute(from);
  if (rawFrom == null) return null;
  const start = snapToBucket(rawFrom);

  // A start alone is a whole answer: a tap on the plot marks when something began and
  // leaves its length to the form.
  if (to === undefined) return { from: start, to: null };

  const rawTo = parseClockMinute(to);
  if (rawTo == null) return null;
  const end = snapToBucket(rawTo);
  // Inverted, equal, or shorter than the chart's own minimum drag — none of these is a
  // window, and none of them is repaired into one.
  if (end - start < MIN_ZOOM_MINUTES) return null;
  return { from: start, to: end };
}

/** The window as the two params `historyHref` writes, for a round trip that closes. */
export function intradayWindowParams(window: IntradayWindow): {
  from: string;
  to?: string;
} {
  return {
    from: formatClockMinute(window.from),
    ...(window.to == null ? {} : { to: formatClockMinute(window.to) }),
  };
}
