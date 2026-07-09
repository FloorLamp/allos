import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import DateField from "./DateField";
import {
  isAllTimeRange,
  isQuickRangeActive,
  quickRanges,
  type DateRange,
} from "@/lib/timeline-format";

// A link that takes {href, className, children}. Defaults to next/link's Link;
// the Timeline passes its scroll-restoring TimelineFilterLink so its quick-range
// pills keep the feed's scroll position (Trends just uses plain links).
type LinkLike = ComponentType<{
  href: string;
  className: string;
  children: ReactNode;
}>;

// next/link's Link has a broader (Url) href type than LinkLike; wrap it so the
// default satisfies the prop type without a cast.
const DefaultLink: LinkLike = ({ href, className, children }) => (
  <Link href={href} className={className}>
    {children}
  </Link>
);

// Shared pill styling for the quick-range chips — identical on the Timeline and
// the Trends hub so the one control looks the same on both.
function rangePillClass(active: boolean): string {
  return `rounded-full px-3 py-1 text-sm font-medium transition ${
    active
      ? "bg-ink-900 text-white dark:bg-white dark:text-ink-950"
      : "bg-white/70 text-slate-600 hover:bg-white dark:bg-ink-900/70 dark:text-slate-300 dark:hover:bg-ink-850"
  }`;
}

// The shared from/to + quick-range control. The Timeline and the Trends hub both
// drive their charts from this one control (issue #212): a GET form that submits
// from/to back to `basePath` (carrying `hiddenParams` — the Timeline's category,
// the hub's active tab), plus 7D/30D/90D/All-time quick-range pills built through
// `buildHref` so each surface preserves its own extra params. `rightSlot` holds
// surface-specific extras (the Timeline's Through/Latest/Oldest affordances).
export default function DateRangeControl({
  basePath,
  range,
  todayStr,
  hiddenParams = {},
  buildHref,
  LinkComponent = DefaultLink,
  rightSlot,
  idPrefix = "range",
}: {
  basePath: string;
  range: DateRange;
  todayStr: string;
  hiddenParams?: Record<string, string | undefined>;
  buildHref: (range: DateRange) => string;
  LinkComponent?: LinkLike;
  rightSlot?: ReactNode;
  idPrefix?: string;
}) {
  const qrs = quickRanges(todayStr);
  return (
    <div className="space-y-2 sm:space-y-4">
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

      <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:justify-between sm:overflow-visible sm:pb-0">
        <div className="flex shrink-0 gap-2 sm:flex-wrap">
          {qrs.map((qr) => (
            <LinkComponent
              key={qr.label}
              href={buildHref({ from: qr.from, to: qr.to })}
              className={rangePillClass(isQuickRangeActive(range, qr))}
            >
              {qr.label}
            </LinkComponent>
          ))}
          <LinkComponent
            href={buildHref({})}
            className={rangePillClass(isAllTimeRange(range))}
          >
            All time
          </LinkComponent>
        </div>
        {rightSlot && (
          <div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
            {rightSlot}
          </div>
        )}
      </div>
    </div>
  );
}
