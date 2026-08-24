import type { ReactNode } from "react";
import BackLink from "@/components/BackLink";
import DateRangeControl from "@/components/DateRangeControl";
import FilterPills, { type FilterPillOption } from "@/components/FilterPills";
import PaginationControls from "@/components/PaginationControls";
import EventLedgerItemFilter from "@/components/ledger/EventLedgerItemFilter";
import { PageHeader } from "@/components/ui";
import type { AppRoute } from "@/lib/hrefs";
import type { DateRange } from "@/lib/timeline-format";

// THE SHARED EVENT-LEDGER FRAME (#3484 part 2).
//
// "Rows of logged events, with editing" is one shape asked of several domains, and it
// had exactly one implementation: a bespoke 347-line shell that knew about doses.
// This is that shell with the doses taken out of it — the FRAME, and only the frame:
//
//   the way back and the page heading · the date-range control · the chip axis ·
//   the item filter · the backfill slot · the window note and the empty state, in
//   the order #3478 settled · the pager
//
// WHERE THE SEAM IS, AND WHY IT IS THERE. A mount brings its own rows, its own write
// actions, and its own sentences; the frame brings the box those sit in. Nothing in
// this file names a domain, and nothing in it may: the amend rules of one domain, the
// plausibility gates of another, and each domain's undo contract are genuinely
// different answers to genuinely different questions, and a frame that grew a branch
// for one of them would be a second implementation of that domain wearing a shared
// name. `lib/__tests__/event-ledger-seam.test.ts` holds that shut by scanning this
// directory for domain vocabulary and for imports of domain modules — so the seam is
// a measured property of the tree rather than an intention in a comment.
//
// AUTH IS THE PAGE'S, as it was in the shell this replaces. Each route resolves its
// own scope and hands its mount an already-authorized profile; the mount hands this
// component finished strings and finished hrefs. This file reads nothing and imports
// no auth module.
//
// ONE `idPrefix`, EVERY TEST ID. The frame's parts are named off a single prefix
// (`dose-ledger` → `dose-ledger-page`, `dose-ledger-empty`, `dose-ledger-pagination`,
// …), which is what the dose shell had already converged on by hand. A mount does not
// get to name the frame's internals: two ledgers whose pagers answered to different
// ids would be two frames again as far as any spec or census is concerned.

/**
 * One chip on the frame's narrowing axis. Re-exported rather than left to the mounts
 * to import from `@/components/FilterPills`: the frame owns which primitive draws its
 * chips, and a mount reaching past it for that type is the first step to a mount that
 * renders the chips itself.
 */
export type EventLedgerChipOption<K extends string> = FilterPillOption<K>;

/** The chip axis: one narrowing question with a closed vocabulary, as links. */
export interface EventLedgerChipAxis<K extends string> {
  options: readonly EventLedgerChipOption<K>[];
  value: K;
  /** Names the control for assistive tech, e.g. "Filter dose history by kind". */
  label: string;
}

/** The item filter: the profile's own items, which is an OPEN vocabulary. */
export interface EventLedgerItemAxis {
  options: { id: string | number; label: string }[];
  value?: string | number;
  /** The visible field label; defaults to "Item". */
  label?: string;
}

/** The page of a SERVER-paged read, whose page rides the URL (#2445). */
export interface EventLedgerPagination {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  visibleCount: number;
  prevHref: AppRoute | null;
  nextHref: AppRoute | null;
}

export default function EventLedgerFrame<K extends string>({
  idPrefix,
  back,
  title,
  subtitle,
  basePath,
  range,
  todayStr,
  rangeHiddenParams,
  buildRangeHref,
  chips,
  itemFilter,
  pagination,
  empty,
  note,
  emptyNote,
  backfill,
  footer,
  children,
}: {
  /** Names every part of the frame; see the header note. */
  idPrefix: string;
  back: { href: AppRoute; label: string };
  title: string;
  subtitle?: ReactNode;
  /** The date-range form's action target — the ledger's own route. */
  basePath: string;
  range: DateRange;
  todayStr: string;
  /** What the range form must carry across a submit (the other axes, the sentinel). */
  rangeHiddenParams?: Record<string, string | undefined>;
  buildRangeHref: (range: DateRange) => AppRoute;
  chips?: EventLedgerChipAxis<K>;
  itemFilter?: EventLedgerItemAxis;
  pagination: EventLedgerPagination;
  /** Whether this page of the read came back with no rows. */
  empty: boolean;
  /**
   * What the window is bounded to, rendered rather than left implicit so a list that
   * stops at the range's edge never reads as "nothing happened before this". The
   * POPULATED case's note only — empty, the bound belongs inside `emptyNote`.
   */
  note?: string;
  /** The EMPTY case's whole sentence: state, window and way out in one (#3478). */
  emptyNote: string;
  /** The mount's backfill affordance ("Log past dose", …). Omitted for a reader who may not write. */
  backfill?: ReactNode;
  /** Anything the mount says below the card — a cross-link to the same question's chart, say. */
  footer?: ReactNode;
  /** The mount's rows. Not rendered in the empty case, which has its own sentence. */
  children: ReactNode;
}) {
  return (
    <div data-testid={`${idPrefix}-page`}>
      {/* A forward link is not a back (#3237). A header action may still offer the
          onward door; this is the way out of the ledger. */}
      <BackLink href={back.href} label={back.label} />
      <PageHeader title={title} subtitle={subtitle} />

      <div className="mb-4 space-y-3">
        <DateRangeControl
          basePath={basePath}
          range={range}
          todayStr={todayStr}
          hiddenParams={rangeHiddenParams}
          buildHref={buildRangeHref}
          idPrefix={idPrefix}
        />
        {chips || itemFilter ? (
          <div className="flex flex-wrap items-center gap-3">
            {chips ? (
              <FilterPills
                options={chips.options}
                value={chips.value}
                label={chips.label}
                testId={`${idPrefix}-kind-filter`}
              />
            ) : null}
            {itemFilter ? (
              <EventLedgerItemFilter
                items={itemFilter.options}
                value={itemFilter.value}
                label={itemFilter.label}
                testId={`${idPrefix}-item-filter`}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div data-testid={idPrefix}>
          {/* THE ORDER IS THE STATE'S, NOT THE ACTION'S (#3478 item 3). An empty
              ledger used to open with its backfill button and two sentences of scope
              prose before it got round to saying it was empty — under a page header
              that had already explained the surface. Empty, the state leads and the
              backfill slot follows it; populated, the slot keeps its place above rows
              that are actually there. This ordering is the FRAME's because it is a
              property of "a list that may be empty", not of any one domain's rows. */}
          {empty ? (
            <>
              <p
                className="text-sm text-slate-500 dark:text-slate-400"
                data-testid={`${idPrefix}-empty`}
              >
                {emptyNote}
              </p>
              {backfill ? <div className="mt-3">{backfill}</div> : null}
            </>
          ) : (
            <>
              {backfill ? <div className="mb-3">{backfill}</div> : null}
              {note ? (
                <p
                  className="mb-2 text-xs text-slate-500 dark:text-slate-400"
                  data-testid={`${idPrefix}-window-note`}
                >
                  {note}
                </p>
              ) : null}
              {children}
            </>
          )}
        </div>
        {/* A LINK pager: the page rides the URL, so what it turns is the READ (#2445).
            Every other control here drops the page — a narrowed ledger re-pages from
            its first row rather than landing the reader on a page the new filter may
            not have — which is the mount's business, since the mount builds the hrefs. */}
        <PaginationControls
          page={pagination.page}
          pageCount={pagination.pageCount}
          pageSize={pagination.pageSize}
          total={pagination.total}
          visibleCount={pagination.visibleCount}
          prevHref={pagination.prevHref}
          nextHref={pagination.nextHref}
          testId={`${idPrefix}-pagination`}
        />
      </div>

      {footer}
    </div>
  );
}
