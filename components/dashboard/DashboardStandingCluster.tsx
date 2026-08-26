import Link from "next/link";
import type { ReactNode } from "react";
import { StandingDestinationLink } from "@/components/DestinationLink";
import type { AppRoute } from "@/lib/hrefs";
import { trackedPageFor } from "@/lib/recent-pages";
import StandingSparkline, {
  type StandingSparklineSeries,
} from "./StandingSparkline";
import {
  STANDING_READING_ORDER,
  type StandingSectionKey,
} from "@/lib/dashboard-standing";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

export interface DashboardStandingPresentation {
  label?: string;
  value?: ReactNode;
  detail?: ReactNode;
  href?: AppRoute;
  actionLabel?: string;
  presence?: "never" | "current" | "dormant";
  /**
   * The row's existing trend read, drawn in the desktop column (#3252). Absent for
   * every row whose domain has no trend read — that is the rule, not an omission.
   */
  series?: StandingSparklineSeries;
  /** Touch- and keyboard-accessible explanatory detail. */
  disclosure?: string;
}

// The door's label: the DESTINATION's own name, taken from the one list that already
// maps a route to what it is called (lib/recent-pages TRACKED_PAGES, which also cuts
// the `#body` fragment — a section is a position on a page, never a different page).
// Nothing is invented here: an untracked href simply gets no door, which is the honest
// answer when the app has no name for where the row goes.
function doorLabel(href: AppRoute): string | null {
  return trackedPageFor(href)?.label ?? null;
}

const SECTIONS: readonly {
  key: StandingSectionKey;
  label: string;
}[] = [
  { key: "today", label: "Today" },
  { key: "body", label: "Body" },
  { key: "longer-view", label: "Longer view" },
];

export default function DashboardStandingCluster({
  placements,
  presentations,
}: {
  placements: readonly Extract<DashboardPlacement, { lane: "standing" }>[];
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  return (
    <section
      className="section-seam-lg mb-8"
      aria-labelledby="dashboard-standing-title"
    >
      <h2
        id="dashboard-standing-title"
        className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100"
      >
        Standing
      </h2>
      <div
        className="overflow-hidden rounded-xl border border-(--border) bg-surface"
        data-testid="dashboard-standing"
      >
        {SECTIONS.map((section) => {
          const families = STANDING_READING_ORDER.flatMap((family) => {
            if (family.section !== section.key) return [];
            const members = placements.filter(
              (placement) => placement.standingFamilyKey === family.key
            );
            return members.length > 0 ? [{ family, members }] : [];
          });
          if (families.length === 0) return null;
          return (
            <section
              key={section.key}
              aria-labelledby={`dashboard-standing-${section.key}`}
              data-standing-section={section.key}
              className="border-b border-(--divider) last:border-b-0"
            >
              <h3
                id={`dashboard-standing-${section.key}`}
                className="bg-(--ghost) px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
              >
                {section.label}
              </h3>
              <dl>
                {families.map(({ family, members }) => {
                  // ONE sparkline per FAMILY, in a fixed trailing column, which is what
                  // makes the column ALIGNED rather than a plot tucked after each
                  // member's text: every family's third cell starts at the same x. The
                  // family's series is its primary reading's — the weight family's
                  // "Latest" row carries it, its "Trend" row is a link.
                  const series = members
                    .map(
                      (placement) =>
                        presentations.get(placement.candidate.candidateId)
                          ?.series
                    )
                    .find((entry) => entry != null);
                  // WHO CARRIES THE ROW'S LINK SURFACE (#3555 ruling 2). A STACKED
                  // family gives every member its own line, so every linked member
                  // carries its own surface over its own line's band. Every other
                  // composition puts all its members on ONE line, which can only have
                  // ONE surface: the first member that is a link takes it, and the
                  // others sit above it (`z-10` below) so their own text stays the
                  // thing you click. Undefined when no member of the family links
                  // anywhere — a row with nowhere to go gets no surface and no door.
                  const stacked = family.composition === "members";
                  const surfaceId = stacked
                    ? undefined
                    : members.find(
                        (placement) =>
                          presentations.get(placement.candidate.candidateId)
                            ?.href
                      )?.candidate.candidateId;
                  return (
                    // THE BREAKPOINT IS IN rem AND MUST STAY IN rem (#3459).
                    // 45rem is 720px at the root default — the same seam #3252
                    // ruled — but Tailwind cannot order an ARBITRARY px
                    // breakpoint against its named rem ones, so the same seam
                    // spelled in px emits BEFORE every `sm:` rule. At >=720px
                    // both queries match, the selectors tie on specificity, and
                    // the later `sm:` two-column template wins: the third column
                    // never applied at ANY width, while the cell below turned
                    // visible on its own and auto-flowed onto a second grid row.
                    //
                    // THE TREND TRACK IS DECLARED ONLY WHERE A PLOT EXISTS (#3555
                    // ruling 3). A family with no `series` keeps the two-column
                    // template at every width, so its facts cell — and therefore its
                    // door's rail — runs to the row's own edge instead of stopping
                    // 192px short over a track nothing draws in. This costs the
                    // plotted families' alignment nothing: the enclosing `<dl>` is not
                    // a grid, so each family's row is an INDEPENDENT grid container
                    // with no tracks shared across families. Plots line up because
                    // every plotted family declares the same fixed `10rem … 11rem`
                    // sizes, not because plotless families reserve an empty cell.
                    //
                    // `--standing-lead` / `--standing-trail` are the distance from the
                    // facts cell's own edges out to the row's padding edges — the name
                    // track plus its gap plus the row's `px-4`, and the trend track
                    // plus its gap plus the same padding where that track exists. They
                    // are declared HERE, beside the template whose track sizes they
                    // restate, because the row-wide link surface (app/globals.css,
                    // "Dashboard hover doors") is anchored inside the facts cell and
                    // has to reach back out over them.
                    <div
                      key={family.key}
                      className={`relative grid gap-1 border-t border-(--divider) px-4 py-3 [--standing-lead:1rem] [--standing-trail:1rem] first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4 sm:[--standing-lead:12rem] min-[45rem]:items-center ${
                        series
                          ? "min-[45rem]:grid-cols-[10rem_minmax(0,1fr)_11rem] min-[45rem]:[--standing-trail:13rem]"
                          : ""
                      }`}
                      data-standing-family={family.key}
                      data-standing-composition={family.composition}
                      // The fork itself, named so a guard can ask which template a row
                      // is on rather than inferring it from whether a plot happened to
                      // draw (a series of fewer than two readable points draws
                      // nothing, and would read as plotless while sitting on the
                      // three-column template).
                      data-standing-trend={series ? "" : undefined}
                    >
                      <dt className="text-sm font-medium text-slate-600 dark:text-slate-300">
                        {family.label}
                      </dt>
                      {/* THE FACTS CELL IS THE RAIL AND THE BAND. `relative` makes this
                        cell the containing block for both out-of-flow boxes a shared
                        line needs — the door at its right edge, and the row-wide link
                        surface that reaches back out from it — and `self-stretch` gives
                        that surface the full height of the row's first grid line, so
                        the sparkline beside it is inside the band rather than beside
                        it. A STACKED family overrides both from its `li` below, which
                        is nearer. */}
                      <dd className="relative flex min-w-0 items-center min-[45rem]:self-stretch">
                        {/* THE DOOR'S RAIL (#3459 item 2, moved by #3555 ruling 3).
                          Every door in this family lands on ONE x — the right edge of
                          the facts cell — instead of trailing whichever member's text
                          it happens to follow. On a family with a plot that is
                          immediately left of the plot; on a plotless family the facts
                          cell now runs to the row's edge, so the door does too. The
                          box it is pinned to is whichever element is exactly one LINE
                          wide for the hovered member: a `members` family stacks, so
                          each `li` is that line; every other composition puts its
                          members on ONE line, so this cell is. Both end on the facts
                          cell's right edge, which is the whole point. */}
                        <ul
                          className={`flex min-w-0 flex-1 gap-1.5 ${
                            family.composition === "members"
                              ? "flex-col"
                              : "flex-row flex-wrap gap-x-4"
                          }`}
                        >
                          {members.map((placement) => {
                            const { candidate } = placement;
                            const presentation = presentations.get(
                              candidate.candidateId
                            );
                            if (!presentation) return null;
                            const engagement =
                              candidate.relevance.kind === "profile-data"
                                ? candidate.relevance.engagement
                                : undefined;
                            const content = (
                              <>
                                {presentation.label && (
                                  // The row's IDENTITY — what the reading is, as
                                  // opposed to what it says. Named so a layout guard
                                  // can assert a long value never costs a Standing
                                  // reading its name (#2614), which is a claim about
                                  // this span rather than about any one family.
                                  <span
                                    data-testid="standing-label"
                                    className="text-xs text-slate-500 dark:text-slate-400"
                                  >
                                    {presentation.label}
                                  </span>
                                )}
                                {presentation.value != null && (
                                  <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                                    {presentation.value}
                                  </span>
                                )}
                                {presentation.detail != null && (
                                  <span className="text-xs text-slate-500 dark:text-slate-400">
                                    {presentation.detail}
                                  </span>
                                )}
                                {presentation.actionLabel && (
                                  <span className="text-xs font-medium text-brand-700 dark:text-brand-400">
                                    {presentation.actionLabel}
                                  </span>
                                )}
                              </>
                            );
                            const className =
                              "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm";
                            // The door: where this row goes, revealed on hover and on
                            // keyboard focus alike. It is PINNED to the right edge of
                            // the family's facts cell (#3459 item 2) and only fades and
                            // slides — being out of flow, it can never move the row,
                            // and nothing yields its place to it: the reading's date
                            // stays fully visible underneath (#3555 ruling 1,
                            // app/globals.css, "Dashboard hover doors").
                            // `pointer-events-none` because every member's door box
                            // occupies the SAME rail: a door that could take the
                            // pointer would let the rail reveal a neighbour's door
                            // instead of its own. No door on a row that is not a link.
                            const door = presentation.href
                              ? doorLabel(presentation.href)
                              : null;
                            const rowDisclosure = presentation.disclosure;
                            // The row-wide link surface (#3555 ruling 2), stretched
                            // from this anchor by app/globals.css.
                            const surface =
                              presentation.href &&
                              (stacked || candidate.candidateId === surfaceId)
                                ? "standing-stretch "
                                : "";
                            const linked = presentation.href ? (
                              door ? (
                                <StandingDestinationLink
                                  href={presentation.href}
                                  className={`${surface}standing-row ${className} hover:text-brand-700 dark:hover:text-brand-400`}
                                  destinationLabel={door}
                                >
                                  {content}
                                </StandingDestinationLink>
                              ) : (
                                <Link
                                  href={presentation.href}
                                  className={`${surface}standing-row ${className} hover:text-brand-700 dark:hover:text-brand-400`}
                                >
                                  {content}
                                </Link>
                              )
                            ) : null;
                            return (
                              <li
                                key={candidate.candidateId}
                                className={
                                  stacked
                                    ? "relative"
                                    : candidate.candidateId === surfaceId
                                      ? undefined
                                      : // Above the shared line's one link surface, so
                                        // this member's own text is still what a
                                        // pointer lands on. A flex item takes a
                                        // `z-index` without being positioned, which
                                        // matters: `relative` here would move the
                                        // door's rail onto this member's own text box.
                                        "z-10"
                                }
                                data-testid="dashboard-candidate"
                                data-candidate-id={candidate.candidateId}
                                data-fact-key={candidate.factKey}
                                data-lane="standing"
                                data-kind={candidate.kind}
                                data-engagement={engagement}
                                data-presence={presentation.presence}
                              >
                                {linked ? (
                                  rowDisclosure ? (
                                    <div className="flex min-w-0 items-center">
                                      {linked}
                                      <InfoTooltipIcon label={rowDisclosure} />
                                    </div>
                                  ) : (
                                    linked
                                  )
                                ) : (
                                  <div className={className}>
                                    {content}
                                    {rowDisclosure ? (
                                      <InfoTooltipIcon label={rowDisclosure} />
                                    ) : null}
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </dd>
                      {/* StandingSparkline places its plot in the trailing desktop
                        column and its disclosure across the two content columns below,
                        where the full contextual label has honest width. The column
                        exists only for a family that draws in it (#3555 ruling 3): a
                        family with no trend read renders neither the cell nor the
                        track. */}
                      {series && <StandingSparkline series={series} />}
                    </div>
                  );
                })}
              </dl>
            </section>
          );
        })}
      </div>
    </section>
  );
}
