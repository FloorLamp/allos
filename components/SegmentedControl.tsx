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
  testId?: string;
  dataAttributes?: Record<string, string | number>;
}

export default function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  ariaCurrent = "page",
  testId,
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
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      className={`inline-flex rounded-lg bg-slate-100 p-1 dark:bg-ink-800 ${className}`}
    >
      {options.map((option) => {
        const active = value === option.value;
        const segmentClass = `shrink-0 rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap transition ${
          option.icon ? "inline-flex items-center gap-1.5 " : ""
        }${
          active
            ? "bg-white text-slate-900 shadow-xs dark:bg-ink-700 dark:text-slate-100"
            : "text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:text-slate-500 dark:text-slate-400 dark:hover:text-slate-100 dark:disabled:hover:text-slate-400"
        }`;
        const body = (
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
              data-testid={option.testId}
              {...option.dataAttributes}
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
            disabled={option.disabled}
            data-testid={option.testId}
            {...option.dataAttributes}
            className={segmentClass}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
