import ScrollFade from "@/components/ScrollFade";
import Chip from "@/components/Chip";
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
  href: AppRoute;
};

type FilterPillButtonOption<T extends string> = {
  value: T;
  label: string;
  href?: never;
};

type FilterPillsProps<T extends string> = {
  value: T;
  label: string;
  testId?: string;
  optionTestId?: (value: T) => string;
} & (
  | {
      mode: "link";
      options: readonly FilterPillOption<T>[];
      onSelect?: never;
    }
  | {
      mode: "button";
      options: readonly FilterPillButtonOption<T>[];
      onSelect: (next: T) => void;
    }
);

export default function FilterPills<T extends string>(
  props: FilterPillsProps<T>
) {
  // ── THE FILTER ROLE OF THE CHIP PRIMITIVE (#3475) ─────────────────────────
  //
  // The class list this component used to hand-write IS the filter role, and it
  // now lives once in `app/globals.css` as `chip chip-filter`. Nothing here
  // changed shape, padding or colour; what changed is that the next filter-ish
  // strip inherits this instead of copying it.
  //
  // 34px TALL — `px-3 py-1.5` around `text-sm` plus the primitive's reserved 1px
  // border, no explicit min-height — rather than the 44px tap floor. (It was 32
  // here before the primitive; the two extra pixels are the border the nav role
  // has always drawn, now reserved by BOTH roles so the two strips occupy the
  // same box. Measured, in e2e/records-pane-anatomy.mobile.spec.ts.) These sit shoulder to shoulder in a scrolling row,
  // and a 44px-tall strip of seven is a band of chrome above the list it is
  // meant to narrow. The floor's own wording is about a control a finger must
  // ACQUIRE; a pill in a horizontal strip is acquired by its WIDTH, which is
  // never the constrained axis here — the strip scrolls sideways and each label
  // carries its own hit area along it. The primitive declares no floor for
  // exactly this reason, so the number survives the move.
  //
  // AND THE SELECTED SHADE IS NO LONGER WRITTEN HERE AT ALL. The lit state is
  // painted from `aria-pressed` / `aria-current`, which this component already
  // carried because a colour-only answer to "which filter am I in?" is
  // unreadable to AT and to a test. A filter cannot look active without saying
  // it is.
  return (
    <ScrollFade
      role="group"
      aria-label={props.label}
      data-testid={props.testId ?? "filter-pills"}
      // The marker the class-level "nav chips and filter chips are visually
      // distinct" assertion reads, so that claim does not have to be spelled as a
      // brittle list of Tailwind classes in a spec.
      data-chip-role="filter"
      className="flex gap-2"
    >
      {props.mode === "link"
        ? props.options.map((o) => {
            const active = o.value === props.value;
            return (
              <Chip
                key={o.value}
                role="filter"
                href={o.href}
                current={active}
                testId={props.optionTestId?.(o.value)}
              >
                {o.label}
              </Chip>
            );
          })
        : props.options.map((o) => {
            const active = o.value === props.value;
            return (
              <Chip
                key={o.value}
                role="filter"
                pressed={active}
                testId={props.optionTestId?.(o.value)}
                onClick={() => props.onSelect(o.value)}
              >
                {o.label}
              </Chip>
            );
          })}
    </ScrollFade>
  );
}
