"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

// Shared compact selector used when several mutually-exclusive views fit on one
// line. Extracted from the Sleep page's 14 / 30 / 90 day range control so dense
// selectors use the same inset track and selected surface.
//
// TWO BINDINGS, and they are exclusive — the same split #2546 gave the pager, for
// the same reason: the two kinds of selection are genuinely different, not two ways
// of writing one.
//
//   • `onChange` — the selection is CLIENT STATE. The segments are `<button>`s and
//     the selected one carries `aria-pressed`, which is a toggle-button state.
//   • option `href` — the selection lives in the URL. The segments are `<Link>`s and
//     the selected one carries `aria-current`, which is what a link representing the
//     current view uses.
//
// The link binding exists because its absence was an accessibility defect, not a
// tidiness one (#2535). With client state as the only contract, every GET-linked
// selector in the app had to hand-roll its own — four of them, two near-identical —
// and all four marked the selection with `aria-pressed` ON A `<Link>`. An `<a href>`
// is `role="link"`, which does not support that state, so the attribute was invalid
// and assistive technology announced NO selected state at all: a screen-reader user
// could not tell which mode Timeline was in or which view the body census showed.
// The visual selection was carried entirely by `className`. Meanwhile the three
// surfaces that could reach this component got it right for free — which is the
// whole argument for the binding living here rather than in each caller.
//
// The link binding is a plain `<Link>`, deliberately, not `PendingNavLink`. That
// rule is about NAV ROWS (the sidebar), and PendingNavLink's own doctrine is that
// its two halves — immediate feedback and repeat-tap suppression — are worth having
// TOGETHER, that "one alone is not enough". A segment is a small control with no
// icon slot to give up to a spinner, so it could take the guard but not the
// feedback, and suppressing the second tap while still showing nothing for the first
// is worse than neither. #2546's pager links took the same decision. If segments
// ever earn a pending state, both halves arrive together.
//
// `lib/__tests__/link-aria-pressed-scan.test.ts` fails `aria-pressed` on a link
// anywhere under app/ or components/, so the next URL-state selector cannot repeat
// the defect by hand-rolling around this component again.

export interface SegmentedControlOption<T extends string | number> {
  value: T;
  label: string;
  // Link binding: this segment's URL. Present on every option or on none — a track
  // where some segments navigate and others mutate client state is two controls.
  href?: AppRoute;
  // Rendered before the label, inside the segment.
  icon?: ReactNode;
  disabled?: boolean;
  accessibleLabel?: string;
  testId?: string;
  dataAttributes?: {
    "data-active"?: string;
    "data-days-ago"?: number;
    "data-observation-count"?: number;
  };
}

export default function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  ariaCurrent = "page",
  testId,
  fill = false,
  className = "",
}: {
  options: SegmentedControlOption<T>[];
  value: T;
  // Button binding. Omit when the options carry `href`.
  onChange?: (value: T) => void;
  ariaLabel: string;
  // Link binding only — what the selected segment IS relative to the page.
  //   "page" — the segments are the same surface at different URLs, so the selected
  //            one IS the page being viewed (Timeline's By date / By person, the
  //            care trail's Illness / Visits).
  //   "true" — the segments re-present the page you are already on, whose identity
  //            did not change (the body census's Tiles / All charts). "page" would
  //            overclaim there.
  ariaCurrent?: "page" | "true";
  testId?: string;
  // Opt-in equal-width track. The root owns its display mode so a caller never
  // has to beat `inline-flex` through Tailwind's generated utility order.
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      // Identifies the shared control for styling and tests.
      data-segmented=""
      className={`${fill ? "flex w-full" : "inline-flex"} rounded-lg bg-(--seg-bg) p-1 ${className}`}
    >
      {options.map((option) => {
        const active = value === option.value;
        // The selected segment fills with the shared seg-active pair (the
        // Botanical census's accent-filled pill). Each option wears THE CONTROL
        // BOX (#3938, extended to segments by #3954) — no height here, and no
        // `py-*`: the unlayered rule in app/globals.css derives both from
        // `--control-box` and the segment's own line box, so a track is exactly
        // as tall as the chips and buttons it sits beside. `border-transparent`
        // because the box reserves a 1px border inside the height for every
        // control kind; a segment's role is painted by its fill, not a frame.
        const segmentClass = `inline-flex items-center justify-center rounded-md border-transparent px-3 text-xs font-medium whitespace-nowrap transition ${
          fill ? "min-w-0 flex-1 " : "shrink-0 "
        }${option.icon ? "gap-1.5 " : ""}${
          active
            ? "bg-(--seg-active-bg) text-(--seg-active-fg) shadow-xs"
            : "text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:text-slate-500 dark:text-slate-400 dark:hover:text-slate-100 dark:disabled:hover:text-slate-400"
        }`;
        // Keep intrinsic consumers' rendered body byte-for-byte unchanged. An
        // Filled segments wrap their complete label instead of hiding it behind
        // hover-only metadata.
        const body = fill ? (
          <>
            {option.icon}
            <span className="min-w-0 whitespace-normal wrap-break-word">
              {option.label}
            </span>
          </>
        ) : (
          <>
            {option.icon}
            {option.label}
          </>
        );
        if (option.href) {
          return (
            <Link
              key={option.value}
              href={option.href}
              aria-current={active ? ariaCurrent : undefined}
              aria-label={option.accessibleLabel}
              data-segmented-option=""
              data-testid={option.testId}
              data-active={option.dataAttributes?.["data-active"]}
              data-days-ago={option.dataAttributes?.["data-days-ago"]}
              data-observation-count={
                option.dataAttributes?.["data-observation-count"]
              }
              className={segmentClass}
            >
              {body}
            </Link>
          );
        }
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange?.(option.value)}
            aria-pressed={active}
            aria-label={option.accessibleLabel}
            data-segmented-option=""
            disabled={option.disabled}
            data-testid={option.testId}
            data-active={option.dataAttributes?.["data-active"]}
            data-days-ago={option.dataAttributes?.["data-days-ago"]}
            data-observation-count={
              option.dataAttributes?.["data-observation-count"]
            }
            className={segmentClass}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
