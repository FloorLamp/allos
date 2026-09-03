"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { bulkCorrectionHref, dataSectionHref } from "@/lib/hrefs";
import type { CorrectionFieldId } from "@/lib/bulk-correction";

// ONE FOOTER, ONE OWNER, ONE PADDING (#4924 fix 5).
//
// THE DEFECT, from the owner's screenshot. Three components were each rendering
// part of one card's footer. `ChartCard` reserved a fixed-height plot slot and
// printed its `footer` after it. `TrendMetricCharts` composed a second footer of
// its own (a projection note, the card's free-form footer, a right-aligned
// action). And `LineChartCardInner` returned a wrapper holding the plot AND its
// four honesty captions INSIDE the plot slot — a box with a committed height, so
// the captions overflowed it: Active Calories and HRV printed flush against the
// card's bottom edge with no padding at all, and Mood, which had a caption from
// the chart and a footer from the card, printed the two on top of each other.
//
// THE OWNER IS THE CARD. It already owns the plot's height and the card's
// padding, so it owns the band underneath too: captions, then the footer, then
// the footer action, in ONE wrapper, in normal flow, with one gap between them.
//
// THE CHART HANDS ITS CAPTIONS UP through this context rather than rendering
// them where it stands. A DESCRIPTOR crosses the boundary, not JSX: the sentences
// are the chart's (only it knows its own gaps, its aggregation and its sources)
// and the LAYOUT is the card's, which is exactly the split that was missing. It
// also means the band can see whether a live outage is being named, which is what
// earns the "Fix a range" action below rather than it being hand-placed.

export interface ChartCaptionSet {
  /** Which source is plotted, and who else reported those days (#2653 state 6). */
  spread?: string;
  /** Each point is a calendar-bucket summary (#1938). */
  longRange?: string;
  /** The demoted plot's reading count (#2653 state 5). */
  sparse?: string;
  /**
   * A LIVE outage: "No data since Aug 8" (#2653 state 4). The band adds the
   * route to the diagnosis — and, for a metric the review page can correct, the
   * bulk-correction door, because a run that stopped is the same shape of
   * problem as a run that came in wrong.
   */
  trailingOutage?: string;
}

const CaptionSlot = createContext<
  ((captions: ChartCaptionSet | null) => void) | null
>(null);

/**
 * Hand this chart's captions to the card hosting it. A chart with no card above
 * it renders no captions — the band is the only place they belong.
 */
export function useChartCaptions(captions: ChartCaptionSet | null): void {
  const slot = useContext(CaptionSlot);
  // The descriptor is rebuilt on every render, so the EFFECT keys on its content
  // rather than its identity; without that this is a render loop.
  const key = captions ? JSON.stringify(captions) : "";
  useEffect(() => {
    if (!slot) return;
    slot(key ? (JSON.parse(key) as ChartCaptionSet) : null);
    return () => slot(null);
  }, [slot, key]);
}

const NOTE_CLASS = "text-xs text-slate-500 dark:text-slate-400";

export default function ChartCaptionBand({
  footer,
  footerAction,
  fixRangeField,
  children,
}: {
  footer?: ReactNode;
  footerAction?: ReactNode;
  // The `?fix=` key the review page accepts for this card's metric, when it has
  // one. The action is EARNED, not placed: it renders only while a live outage
  // is being named, and every metric with a key gets it on the same terms.
  fixRangeField?: CorrectionFieldId;
  children: ReactNode;
}) {
  // `setCaptions` is stable, so the context value never changes identity and the
  // hook's effect below runs on its own content alone.
  const [captions, setCaptions] = useState<ChartCaptionSet | null>(null);
  const fixRange = captions?.trailingOutage ? fixRangeField : undefined;
  const hasBand = Boolean(
    captions?.spread ||
    captions?.longRange ||
    captions?.sparse ||
    captions?.trailingOutage ||
    footer ||
    footerAction ||
    fixRange
  );

  return (
    <CaptionSlot.Provider value={setCaptions}>
      {children}
      {hasBand && (
        <div
          data-testid="chart-card-footer"
          className="mt-2 flex flex-col gap-1.5 pb-0.5"
        >
          {captions?.spread && (
            <p className={NOTE_CLASS} data-testid="chart-source-spread-note">
              {captions.spread}
            </p>
          )}
          {captions?.longRange && (
            <p className={NOTE_CLASS} data-testid="chart-long-range-note">
              {captions.longRange}
            </p>
          )}
          {captions?.sparse && (
            <p className={NOTE_CLASS} data-testid="chart-sparse-note">
              {captions.sparse}
            </p>
          )}
          {captions?.trailingOutage && (
            <p className={NOTE_CLASS} data-testid="chart-trailing-outage-note">
              {captions.trailingOutage} ·{" "}
              <Link
                href={dataSectionHref("review")}
                className="text-link"
                data-testid="chart-trailing-outage-link"
              >
                Data → Review
              </Link>
            </p>
          )}
          {footer}
          {(footerAction || fixRange) && (
            <div className="flex justify-end">
              {footerAction}
              {fixRange && (
                <Link
                  href={bulkCorrectionHref(fixRange)}
                  className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
                  data-testid="chart-fix-range"
                >
                  Fix a range
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </CaptionSlot.Provider>
  );
}
