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
                  const stacked = family.composition === "members";
                  const surfaceId = members.find(
                    (placement) =>
                      presentations.get(placement.candidate.candidateId)?.href
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
                    <div
                      key={family.key}
                      className={`relative grid gap-1 border-t border-(--divider) px-4 py-3 [--standing-lead:1rem] [--standing-trail:1rem] first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4 sm:[--standing-lead:12rem] min-[45rem]:items-center ${
                        series
                          ? "min-[45rem]:grid-cols-[10rem_minmax(0,1fr)_11rem] min-[45rem]:[--standing-trail:13rem]"
                          : ""
                      }`}
                      data-standing-family={family.key}
                      data-standing-composition={family.composition}
                      data-standing-trend={series ? "" : undefined}
                    >
                      <dt className="text-sm font-medium text-slate-600 dark:text-slate-300">
                        {family.label}
                      </dt>
                      <dd className="relative min-w-0 min-[45rem]:self-stretch">
                        {/* THE DOOR'S RAIL (#3459 item 2). Every door in this family
                          lands on ONE x — the right edge of the facts cell, just left
                          of the sparkline column — instead of trailing whichever
                          member's text it happens to follow. The anchor is whichever
                          element is exactly one LINE wide for the hovered member, so
                          the door's y stays on the row you are pointing at: a
                          `members` family stacks, so each `li` is that line; a
                          `single`/`composed` family puts every member on ONE line, so
                          the `ul` is. Both have the dd's right edge, which is the
                          whole point. */}
                        <ul
                          className={`flex min-w-0 gap-1.5 ${
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
                            // and the age it stands in for keeps its own box while it
                            // steps aside (app/globals.css, "Dashboard hover doors").
                            // `pointer-events-none` because every member's door box
                            // occupies the SAME rail: a door that could take the
                            // pointer would let the rail reveal a neighbour's door
                            // instead of its own. No door on a row that is not a link.
                            const door = presentation.href
                              ? doorLabel(presentation.href)
                              : null;
                            const rowDisclosure = presentation.disclosure;
                            const primary = candidate.candidateId === surfaceId;
                            const surface =
                              presentation.href && (stacked || primary)
                                ? `standing-stretch ${primary ? "standing-primary " : ""}`
                                : "";
                            const linked = presentation.href ? (
                              door ? (
                                <StandingDestinationLink
                                  href={presentation.href}
                                  className={`${surface}standing-row ${className} min-[45rem]:pr-32 hover:text-brand-700 dark:hover:text-brand-400`}
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
                                    : primary
                                      ? undefined
                                      : "z-10"
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
                      {/* Only plotted families reserve the trailing track. */}
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
