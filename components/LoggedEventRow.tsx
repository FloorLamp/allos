import type { ReactNode } from "react";

// THE LOGGED-EVENT ROW (#3671).
//
// A logged event is one fact with a clock on it — a serving, a dose, a session, a
// day's substance total — and the app drew it two ways: the Food tab's one-line row
// fitted seven on a phone, every ledger of the same facts fitted two. The owner
// asked for the first one everywhere, so it stops being FoodLogBar's and becomes
// this.
//
// WHAT IS SHARED IS THE ANATOMY, NOT A WRAPPER ELEMENT, and that is why this owns
// the identity half rather than the whole row: the food log's rows are `<li>`s and a
// ledger's are `<tr>`s that CSS re-lays below `sm` (components/ResponsiveTable.tsx),
// and neither may become the other. Both render this, which is what stops them
// drifting into two shapes again.
//
// DIVIDERS, NOT PER-ROW CARDS (owner decision 2026-08-24, over #3077's "one dense
// cluster of rows, not N cards"); `DashboardStandingCluster` is the reference markup.
// FoodLogBar's list carried a border and a fill PER ROW — the second shape this
// exists to retire, so it goes too.

/** The frame a run of logged-event rows sits in: one border, hairlines inside. */
export const LOGGED_EVENT_LIST =
  "overflow-hidden rounded-xl border border-(--border) bg-surface";

/**
 * One row in that frame. `min-h-11` is the #644 tap floor stated where the row is
 * drawn — the compact row is shorter than the card it replaces and must not go
 * under 44px.
 */
export const LOGGED_EVENT_ROW =
  "flex min-h-11 items-center gap-2 border-t border-(--divider) px-3 py-1.5 text-sm text-slate-800 first:border-t-0 dark:text-slate-100";

/**
 * The head line's right-hand fact, in tabular figures so a column of times lines up.
 * The table half gets the same three tokens from `td[data-card="trailing"]` in
 * app/globals.css — card-mode-scoped there, because a table keeps its columns above
 * `sm`.
 */
export const LOGGED_EVENT_TRAILING =
  "shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400";

export default function LoggedEventRow({
  icon,
  children,
}: {
  /** The leading glyph, already sized and `aria-hidden`. Optional: a ledger of dates has nothing to draw here, and an empty gutter is worse than none. */
  icon?: ReactNode;
  /** The row's identity — the food's name, the dose's date, the session. */
  children: ReactNode;
}) {
  return (
    <span
      data-logged-event-row
      className="flex min-w-0 flex-1 items-center gap-2"
    >
      {icon}
      {/* Truncation is card-mode-only: it is what keeps the compact row to ONE line
          on a phone, while a desktop table cell must be free to size its column. */}
      <span className="min-w-0 flex-1 font-medium max-sm:truncate">
        {children}
      </span>
    </span>
  );
}
