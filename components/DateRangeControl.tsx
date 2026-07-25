import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
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
import type { AppRoute } from "@/lib/hrefs";

// A link that takes {href, className, children}. Defaults to next/link's Link;
// the Timeline passes its scroll-restoring TimelineFilterLink so its quick-range
// pills keep the feed's scroll position (Trends just uses plain links).
type LinkLike = ComponentType<{
  href: AppRoute;
  className: string;
  children: ReactNode;
  "aria-current"?: "page";
}>;

// next/link's Link has a broader (Url) href type than LinkLike; wrap it so the
// default satisfies the prop type without a cast.
const DefaultLink: LinkLike = ({
  href,
  className,
  children,
  "aria-current": ariaCurrent,
}) => (
  <Link href={href} className={className} aria-current={ariaCurrent}>
    {children}
  </Link>
);

// Shared pill styling for the quick-range chips — identical on the Timeline and
// the Trends hub so the one control looks the same on both. The active pill also
// carries `aria-current="page"` (see LinkComponent call sites): the lit state was
// previously conveyed by colour ALONE, which neither AT nor a test can read — and
// with Trends' 90D default (#1485 G) "which window am I in?" is answered by the
// pill, so it needs a non-visual answer.
function rangePillClass(active: boolean): string {
  return `rounded-full px-3 py-1 text-sm font-medium transition ${
    active
      ? "bg-ink-900 text-white dark:bg-white dark:text-ink-950"
      : "bg-white/70 text-slate-600 hover:bg-white dark:bg-ink-900/70 dark:text-slate-300 dark:hover:bg-ink-850"
  }`;
}

// The shared from/to + quick-range control. The Timeline and the Trends hub both
// drive their charts from this one control: a GET form that submits
// from/to back to `basePath` (carrying `hiddenParams` — the Timeline's category,
// the hub's active tab), plus 7D/30D/90D/All-time quick-range pills built through
// `buildHref` so each surface preserves its own extra params. `rightSlot` holds
// surface-specific extras (the Timeline's Through/Latest/Oldest affordances) and
// `trailingChips` rides the END of the chip row (the Trends hub's saved views).
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
  LinkComponent = DefaultLink,
  rightSlot,
  trailingChips,
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
            className="card grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 p-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:gap-3 sm:p-4"
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
            <div className="flex items-end">
              <button type="submit" className="btn h-10 px-3 sm:w-full">
                Apply
              </button>
            </div>
            <div className="col-span-3 flex items-end sm:col-span-1">
              <Link
                href={buildHref({})}
                className="btn-ghost w-full py-1.5 text-center sm:py-2"
              >
                Clear dates
              </Link>
            </div>
          </form>
        </CustomRangePanel>

        {/* The chip row. One horizontally-scrolling row on a phone: quick ranges,
            the "Custom…" toggle, then whatever the surface hangs off the end
            (the Trends hub's saved views — #1455 C, so they stop costing a second
            full-width row). It wraps normally from `sm` up. */}
        <div className="order-1 flex items-center gap-2 overflow-x-auto pb-1 sm:order-2 sm:flex-wrap sm:justify-between sm:overflow-visible sm:pb-0">
          <div className="flex shrink-0 items-center gap-2 sm:flex-wrap">
            {qrs.map((qr) => (
              <LinkComponent
                key={qr.label}
                href={buildHref({ from: qr.from, to: qr.to })}
                className={rangePillClass(isQuickRangeActive(range, qr))}
                aria-current={
                  isQuickRangeActive(range, qr) ? "page" : undefined
                }
              >
                {qr.label}
              </LinkComponent>
            ))}
            <LinkComponent
              href={buildHref({})}
              className={rangePillClass(isAllTimeRange(range))}
              aria-current={isAllTimeRange(range) ? "page" : undefined}
            >
              All time
            </LinkComponent>
            <CustomRangeToggle
              className={`shrink-0 sm:hidden ${rangePillClass(customActive)}`}
            />
            {trailingChips}
          </div>
          {rightSlot && (
            <div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
              {rightSlot}
            </div>
          )}
        </div>
      </CustomRangeDisclosure>
    </div>
  );
}
