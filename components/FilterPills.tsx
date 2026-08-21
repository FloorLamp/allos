import Link from "next/link";
import ScrollFade from "@/components/ScrollFade";
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
//
// ── A FILTER DOES NOT DRESS AS A DESTINATION (#3408, item E) ─────────────────
//
// It read as one anyway. This pill and the Records hub's pane chips
// (app/(app)/records/RecordsTabs.tsx) were the SAME rounded-full outline with the
// SAME brand-tinted active state — so History › Immunizations at 430px stacked
// three look-alike strips with three different meanings: hub tabs, pane chips,
// then these. Two of them navigate; this one narrows a list in place. A reader
// cannot tell which by looking, and the screen-reader affordance the paragraph
// above describes is invisible to the eye.
//
// SO A FILTER IS AN INSET CONTROL, NOT AN OUTLINE CHIP. It sits ON the surface
// rather than floating above it: a soft tinted well, `rounded-md` rather than
// `rounded-full`, no border, and an active state that FILLS with brand rather
// than tinting an outline. The vocabulary is deliberately the one this app
// already uses for segmented in-place controls, so the distinction is "control"
// vs "destination" and not "two arbitrary chip styles".
//
// ONE DECISION, EVERY FILTER. This component IS the family's single filter
// affordance (that is what the paragraph above is about), so changing it here is
// the one visual grammar decision the issue asks for — Immunizations' status
// strip, Conditions', Dental's, Skin's and the dose ledger's all move together,
// and the next filter inherits it instead of inventing an eleventh species.
//
// THE ROW SAYS THAT IT SCROLLS. Seven options on a 430px screen overflow with no
// affordance at all — the owner's report — so the scroller is `ScrollFade`, the
// same masked container `RecordTable` already wraps its table in. It publishes
// `data-fade-left`/`data-fade-right`, which makes "this row scrolls, and says so"
// an assertable claim rather than a gradient in a screenshot.
//
// ScrollFade is a client component and this file still declares no directive and
// uses no hooks, so both drive modes keep composing into a server component —
// rendering a client child from a server parent is exactly what that boundary is
// for.

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
  optionTestId,
}: {
  options: readonly FilterPillOption<T>[];
  value: T;
  onSelect?: (next: T) => void;
  // Names the control for assistive tech, e.g. "Filter conditions by status".
  label: string;
  testId?: string;
  // A stable marker per OPTION, for a list whose specs address one state
  // directly (the encounter kind filter's `encounter-kind-ambulatory`). Optional
  // because most filters are addressed by their visible label; supplying it is
  // what let a hand-rolled chip row adopt this component without rewriting its
  // specs (#3408, item E / item G).
  optionTestId?: (value: T) => string;
}) {
  // `min-h-9` (36px) rather than the 44px tap floor: these sit shoulder to
  // shoulder in a scrolling row, and a 44px-tall strip of seven is a band of
  // chrome above the list it is meant to narrow. The floor's own wording is
  // about a control a finger must ACQUIRE; a pill in a horizontal strip is
  // acquired by its width, which is never the constrained axis here. The nav
  // chips it must be told apart from keep their own height.
  const pill = (active: boolean) =>
    `flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${
      active
        ? "bg-brand-600 text-white dark:bg-brand-500 dark:text-ink-950"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-700"
    }`;

  return (
    <ScrollFade
      role="group"
      aria-label={label}
      data-testid={testId ?? "filter-pills"}
      // The marker the class-level "nav chips and filter chips are visually
      // distinct" assertion reads, so that claim does not have to be spelled as a
      // brittle list of Tailwind classes in a spec.
      data-chip-role="filter"
      className="flex gap-2"
    >
      {options.map((o) => {
        const active = o.value === value;
        if (o.href) {
          return (
            <Link
              key={o.value}
              href={o.href}
              aria-current={active ? "true" : undefined}
              data-testid={optionTestId?.(o.value)}
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
            data-testid={optionTestId?.(o.value)}
            onClick={() => onSelect?.(o.value)}
            className={pill(active)}
          >
            {o.label}
          </button>
        );
      })}
    </ScrollFade>
  );
}
