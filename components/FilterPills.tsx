import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";

// The ONE filter affordance for a record list surface (#1449, cluster C).
//
// The records family had grown four controls for one job: Problems used a
// SOLID-FILLED pill group, Immunizations a "Show" + <select>, Skin and Dental a
// bare "All statuses" <select>, none of which matched the outline pill sub-tabs
// the family navigates with. Four shapes for "narrow this list" is the
// responsive-surfaces disease one level up — so this is the single component all
// of them render, and its visual language is the family's own outline pill.
//
// Two drive modes, ONE appearance:
//   - LINK mode (`href` on each option) — a server component can render it with
//     no client JS, and each filter state is a real URL (deep-linkable, works
//     pre-hydration). Preferred wherever the filter already rides a query param.
//   - CALLBACK mode (`onSelect`) — for a client list holding the filter in local
//     state. The parent owns "use client"; this file deliberately declares no
//     directive and uses no hooks, so it composes into either environment.
//
// The row scrolls horizontally rather than wrapping (`overflow-x-auto` +
// `shrink-0`), so a 7-option filter costs ONE line on a phone instead of three —
// the mobile vertical-cost posture of #1416/#1455. Pills carry `aria-pressed`
// (callback mode) or live in a labelled group (link mode) so the control reads
// as a filter, not as navigation, to a screen reader.

export type FilterPillOption<T extends string> = {
  value: T;
  label: string;
  // LINK mode only: where this filter state lives.
  href?: AppRoute;
};

export default function FilterPills<T extends string>({
  options,
  value,
  onSelect,
  label,
  testId,
}: {
  options: readonly FilterPillOption<T>[];
  value: T;
  onSelect?: (next: T) => void;
  // Names the control for assistive tech, e.g. "Filter conditions by status".
  label: string;
  testId?: string;
}) {
  const pill = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-sm font-medium transition ${
      active
        ? "border-brand-600 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/40 dark:text-brand-300"
        : "border-black/10 bg-white/80 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-300 dark:hover:bg-ink-750"
    }`;

  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId ?? "filter-pills"}
      className="flex gap-2 overflow-x-auto"
    >
      {options.map((o) => {
        const active = o.value === value;
        if (o.href) {
          return (
            <Link
              key={o.value}
              href={o.href}
              aria-current={active ? "true" : undefined}
              className={pill(active)}
            >
              {o.label}
            </Link>
          );
        }
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect?.(o.value)}
            className={pill(active)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
