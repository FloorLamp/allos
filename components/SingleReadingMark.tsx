import type { ReactNode } from "react";

// THE ONE-READING MARK (#1485 G, generalised by #2615 item 3).
//
// A line needs two points to describe a direction. Given one, recharts' sparkline mode
// draws nothing at all (per-point dots are suppressed) and the full chart draws a 30-day
// band that is empty apart from a single dot half-clipped against the y-axis. Both read
// as a rendering failure rather than as the true statement: there is one reading here.
//
// So a one-reading series gets its own deliberate mark — a dot on a fading rule, with a
// caption naming what it is and when. The Overview tiles have rendered exactly this since
// #1485 G; the full chart cards did not, which is how the same data came to be drawn two
// ways on one page. This component is that one drawing, so the tile and the card it taps
// through to cannot disagree.
//
// PRESENTATIONAL ONLY. Which series qualifies is `loneReading` (lib/trend-sparkline.ts),
// and the caption's words stay with the caller — "Single reading" on a tile inside the
// window and "Latest recorded" for one behind it are different claims about the same
// drawing, and phrasing is per surface.
export default function SingleReadingMark({
  color,
  caption,
  fill = false,
  testid,
  markTestid,
  readingScope,
  captionClassName = "text-xs tabular-nums text-slate-500 dark:text-slate-400",
}: {
  // The series' own color, so the dot matches the line the card would have drawn.
  color?: string;
  // What the mark says it is. Composed by the caller (see above).
  caption: ReactNode;
  // Fill the height the parent gives it, rather than the tile's fixed 80px band. The
  // chart cards pass this: `.chart-card-plot > *` sizes the direct child to the card's
  // own plot box (square on phones, `sm:h-64` up), so the mark occupies exactly the
  // footprint the populated chart would have and the stack keeps one rhythm.
  fill?: boolean;
  testid?: string;
  // Test hook on the drawn mark itself, separate from the wrapper's.
  markTestid?: string;
  // Whether the one reading falls INSIDE the selected window or is the latest one
  // BEHIND it — the same distinction the caption's words carry, exposed as an
  // attribute so a browser test can assert which state it is looking at.
  readingScope?: "inside" | "outside";
  captionClassName?: string;
}) {
  return (
    <div
      className={`flex flex-col justify-center ${fill ? "h-full" : "mt-auto pt-2"}`}
      data-testid={testid}
      data-reading-scope={readingScope}
    >
      <div
        className={`flex items-center px-3 ${fill ? "flex-1" : "h-20"}`}
        data-testid={markTestid}
        aria-hidden="true"
      >
        <span className="h-px flex-1 bg-linear-to-r from-transparent to-slate-300 dark:to-slate-600" />
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white shadow-xs ring-1 ring-black/10 dark:bg-ink-900 dark:ring-white/15">
          <span
            className="h-2.5 w-2.5 rounded-full bg-brand-500"
            style={color ? { backgroundColor: color } : undefined}
          />
        </span>
        <span className="h-px flex-1 bg-linear-to-l from-transparent to-slate-300 dark:to-slate-600" />
      </div>
      <p
        className={`text-center ${fill ? "pb-2" : "-mt-1"} ${captionClassName}`}
        data-testid="single-reading-caption"
      >
        {caption}
      </p>
    </div>
  );
}
