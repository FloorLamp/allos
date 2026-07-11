import WidgetHeader from "./WidgetHeader";
import type { LowSupplyItem } from "@/lib/refill";

// The shape lives in lib/refill next to selectLowSupplyItems (the pure list
// builder) so the widget stays a formatter over the one computation (#301).
export type { LowSupplyItem };

// Low supply (NEW) — supplements/medications with tracked quantity
// running at or below the refill threshold, computed via lib/refill. Off by
// default; when nothing is low the card reads "All stocked up".
export default function LowSupplyWidget({ items }: { items: LowSupplyItem[] }) {
  return (
    <div className="card">
      <WidgetHeader
        title="Low supply"
        href="/medicine"
        linkLabel="Supplements"
      />
      {items.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          All stocked up — nothing running low.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                {it.name}
              </span>
              <span
                className={`shrink-0 text-xs ${
                  it.daysLeft <= 3
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-amber-600 dark:text-amber-400"
                }`}
              >
                ≈{it.daysLeft} day{it.daysLeft === 1 ? "" : "s"} left
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
