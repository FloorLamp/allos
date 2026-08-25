import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import Chip, { type ChipLinkRenderProps } from "./Chip";
import DateField from "./DateField";
import {
  isAllTimeRange,
  isCustomRange,
  isQuickRangeActive,
  quickRanges,
  type DateRange,
  type QuickRange,
} from "@/lib/timeline-format";
import {
  CustomRangeDisclosure,
  CustomRangePanel,
  CustomRangeToggle,
} from "./CustomRangeDisclosure";
import ScrollFade from "./ScrollFade";
import type { AppRoute } from "@/lib/hrefs";

// Chip owns the link's presentation. Timeline supplies only its scroll-restoring
// renderer so quick ranges keep the feed position and pending treatment; Trends
// uses Chip's default Next link.
type LinkLike = ComponentType<ChipLinkRenderProps>;

// The quick-range chips are FILTERS (#3475): they narrow the window of the chart
// or feed already on screen, in place, and they are not destinations. So they
// wear the chip primitive's filter role rather than the third selected-state
// language they used to hand-roll — a full-round pill whose active state was an
// INK fill, stacked in the dose ledger directly above `components/FilterPills.tsx`
// and its brand fill, which is two answers to "which one is on?" on adjacent
// rows of one filter block.
//
// The active pill carries `aria-current="page"` at every call site below (the
// lit state was once conveyed by colour ALONE, which neither AT nor a test can
// read — and with Trends' 90D default (#1485 G) "which window am I in?" is
// answered by the pill, so it needs a non-visual answer). The primitive now
// paints the lit state FROM that attribute, so the two can no longer disagree.
// The shared from/to + quick-range control. The Timeline and the Trends hub both
// drive their charts from this one control: a GET form that submits
// from/to back to `basePath` (carrying `hiddenParams` — the Timeline's category,
// the hub's active tab), plus 7D/30D/90D/All-time quick-range pills built through
// `buildHref` so each surface preserves its own extra params. `rightSlot` holds
// surface-specific extras (the Timeline's Through/Latest/Oldest affordances),
// `trailingChips` rides the END of the chip row, and `companionSlot` places a
// related control below the pills on phones and beside them on desktop.
//
// Mobile (#1455): below `sm` the chip row is the PRIMARY control — it renders
// first and the From/To card collapses behind its "Custom…" pill (open by default
// when the active window is custom, so a shared URL still shows its dates). From
// `sm` up the layout is unchanged: card first, chip row under it, no toggle.
export default function DateRangeControl({
  basePath,
  range,
  todayStr,
  hiddenParams = {},
  buildHref,
  LinkComponent,
  rightSlot,
  trailingChips,
  companionSlot,
  extraRanges = [],
  idPrefix = "range",
}: {
  basePath: string;
  range: DateRange;
  todayStr: string;
  hiddenParams?: Record<string, string | undefined>;
  buildHref: (range: DateRange) => AppRoute;
  LinkComponent?: LinkLike;
  rightSlot?: ReactNode;
  trailingChips?: ReactNode;
  companionSlot?: ReactNode;
  extraRanges?: QuickRange[];
  idPrefix?: string;
}) {
  const qrs = [...extraRanges, ...quickRanges(todayStr)];
  // The one predicate behind both the default-open panel and the "Custom…" pill's
  // lit state (and, at the call sites, the range-summary chip) — lib/timeline-format.
  const customActive = isCustomRange(range, todayStr, extraRanges);
  return (
    // `gap`, not `space-y`: the two rows swap visual order below `sm` via `order-*`,
    // and space-y's `> * + *` margin follows DOM order, so it would land the gap on
    // whichever row renders SECOND in the markup — i.e. above the visually-first
    // row on a phone.
    <div className="flex flex-col gap-2 sm:gap-4">
      <CustomRangeDisclosure defaultOpen={customActive} idPrefix={idPrefix}>
        <CustomRangePanel className="order-2 sm:order-1">
          <form
            action={basePath}
            className="card grid grid-cols-2 gap-2 p-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:gap-3 sm:p-4"
          >
            {Object.entries(hiddenParams).map(([k, v]) =>
              v ? <input key={k} type="hidden" name={k} value={v} /> : null
            )}
            <div>
              <label className="label" htmlFor={`${idPrefix}-from`}>
                From
              </label>
              <DateField
                key={`from-${range.from ?? ""}`}
                id={`${idPrefix}-from`}
                name="from"
                defaultValue={range.from ?? ""}
              />
            </div>
            <div>
              <label className="label" htmlFor={`${idPrefix}-to`}>
                To
              </label>
              <DateField
                key={`to-${range.to ?? ""}`}
                id={`${idPrefix}-to`}
                name="to"
                defaultValue={range.to ?? ""}
              />
            </div>
            <div className="col-span-2 flex items-end sm:col-span-1">
              <button type="submit" className="btn h-10 w-full px-3">
                Apply
              </button>
            </div>
            <div className="col-span-2 flex items-end sm:col-span-1">
              <Link
                href={buildHref({})}
                className="btn-ghost w-full py-1.5 text-center sm:py-2"
              >
                Clear dates
              </Link>
            </div>
          </form>
        </CustomRangePanel>

        {/* The chip row. One horizontally-scrolling row on a phone: quick ranges
            and the "Custom…" toggle. Desktop surfaces may hang trailing controls
            off the end; it wraps normally from `sm` up.

            #1485 D: when the row overflows, cut-off content with no affordance
            reads as broken layout, not as "scroll me".
            The fix is the app's existing one — components/ScrollFade, the same
            mask-based edge hint the wide tables use — NOT a second hand-rolled
            gradient. The mask is theme-agnostic and self-cancelling: it only paints
            on an edge that actually has content past it, so from `sm` up (where the
            row wraps and `sm:overflow-visible` wins over the component's own base
            `overflow-x-auto`) there is nothing to scroll and no fade. */}
        <div className="order-1 flex flex-col gap-2 sm:order-2 sm:flex-row sm:items-center sm:gap-3">
          <ScrollFade
            data-testid={`${idPrefix}-chip-row`}
            className="flex min-w-0 flex-1 items-center gap-2 pb-1 sm:flex-wrap sm:justify-between sm:overflow-visible sm:pb-0"
          >
            <div className="flex w-max min-w-full shrink-0 items-center justify-between gap-2 sm:w-auto sm:min-w-0 sm:justify-start sm:flex-wrap">
              {qrs.map((qr) => (
                <Chip
                  key={qr.label}
                  role="filter"
                  href={buildHref({ from: qr.from, to: qr.to })}
                  testId={`${idPrefix}-pill-${qr.label}`}
                  current={isQuickRangeActive(range, qr)}
                  LinkComponent={LinkComponent}
                >
                  {qr.label}
                </Chip>
              ))}
              <Chip
                role="filter"
                href={buildHref({})}
                testId={`${idPrefix}-pill-all-time`}
                current={isAllTimeRange(range)}
                LinkComponent={LinkComponent}
              >
                All time
              </Chip>
              <CustomRangeToggle active={customActive} />
              {trailingChips}
            </div>
            {rightSlot && (
              <div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
                {rightSlot}
              </div>
            )}
          </ScrollFade>
          {companionSlot && <div className="shrink-0">{companionSlot}</div>}
        </div>
      </CustomRangeDisclosure>
    </div>
  );
}
