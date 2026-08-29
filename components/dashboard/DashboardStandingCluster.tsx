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
  type StandingBandKey,
  type StandingReadingFamily,
  type StandingSectionKey,
} from "@/lib/dashboard-standing";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import Disclosure from "@/components/Disclosure";

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
  /**
   * THE MOMENT THIS FACT CAME FROM (#3365), printed ONCE as the header of the tail
   * block its same-`groupKey` siblings fold into — "Weekly recap · Aug 23–29" over
   * six lines instead of six identical card headers. It is a label on the fold, never
   * a placement: the block exists only because its atoms placed, and an atom promoted
   * to another lane simply leaves the block with one row fewer. Every member of one
   * group declares the same moment; the canvas reads the first that has one.
   */
  moment?: { title: string; href?: AppRoute };
}

// The door's label: the DESTINATION's own name, taken from the one list that already
// maps a route to what it is called (lib/recent-pages TRACKED_PAGES, which also cuts
// the `#body` fragment — a section is a position on a page, never a different page).
// Nothing is invented here: an untracked href simply gets no door, which is the honest
// answer when the app has no name for where the row goes.
function doorLabel(href: AppRoute): string | null {
  return trackedPageFor(href)?.label ?? null;
}

// THE ROW. One renderer for every label/value fact the dashboard reports, in Standing
// and in the Show-everything tail alike (#3365) — the tail is an index of the same
// grammar, not a second spelling of it. The caller supplies only what its lane owns:
// Standing's door rail and stacking classes, the tail's nothing.
export function DashboardFactRow({
  candidate,
  presentation,
  lane,
  surfaceClass = "",
  linkClass = "",
  className,
}: {
  candidate: DashboardPlacement["candidate"];
  presentation: DashboardStandingPresentation;
  lane: "standing" | "everything";
  surfaceClass?: string;
  linkClass?: string;
  className?: string;
}) {
  const engagement =
    candidate.relevance.kind === "profile-data"
      ? candidate.relevance.engagement
      : undefined;
  const content = (
    <>
      {presentation.label && (
        // The row's IDENTITY — what the reading is, as opposed to what it
        // says. Named so a layout guard can assert a long value never costs a
        // Standing reading its name (#2614), which is a claim about this span
        // rather than about any one family.
        <span
          data-testid="standing-label"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          {presentation.label}
        </span>
      )}
      {presentation.value != null && (
        <span
          data-testid="standing-value"
          className="font-semibold tabular-nums text-slate-900 dark:text-slate-100"
        >
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
  const rowClass =
    "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm";
  // The door: where this row goes, revealed on hover and on keyboard focus alike.
  // No door on a row that is not a link, and no door where the app has no name for
  // the destination — an untracked href is the honest silence.
  const door = presentation.href ? doorLabel(presentation.href) : null;
  const linked = presentation.href ? (
    door ? (
      <StandingDestinationLink
        href={presentation.href}
        className={`${surfaceClass}standing-row ${rowClass} ${linkClass} hover:text-brand-700 dark:hover:text-brand-400`}
        destinationLabel={door}
      >
        {content}
      </StandingDestinationLink>
    ) : (
      <Link
        href={presentation.href}
        className={`${surfaceClass}standing-row ${rowClass} hover:text-brand-700 dark:hover:text-brand-400`}
      >
        {content}
      </Link>
    )
  ) : null;
  const rowDisclosure = presentation.disclosure;
  return (
    <li
      className={className}
      data-testid="dashboard-candidate"
      data-candidate-id={candidate.candidateId}
      data-fact-key={candidate.factKey}
      data-lane={lane}
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
        <div className={rowClass}>
          {content}
          {rowDisclosure ? <InfoTooltipIcon label={rowDisclosure} /> : null}
        </div>
      )}
    </li>
  );
}

const SECTIONS: readonly {
  key: StandingSectionKey;
  label: string;
}[] = [
  { key: "today", label: "Today" },
  { key: "body", label: "Body" },
  { key: "longer-view", label: "Longer view" },
];

type StandingPlacement = Extract<DashboardPlacement, { lane: "standing" }>;

function StandingFamilyRow({
  family,
  members,
  presentations,
}: {
  family: StandingReadingFamily;
  members: readonly StandingPlacement[];
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  // ONE sparkline per FAMILY, in a fixed trailing column, which is what
  // makes the column ALIGNED rather than a plot tucked after each
  // member's text: every family's third cell starts at the same x. The
  // family's series is its primary reading's — the weight family's
  // "Latest" row carries it, its "Trend" row is a link.
  const series = members
    .map(
      (placement) => presentations.get(placement.candidate.candidateId)?.series
    )
    .find((entry) => entry != null);
  const stacked = family.composition === "members";
  const surfaceId = members.find(
    (placement) => presentations.get(placement.candidate.candidateId)?.href
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
      className={`band relative grid gap-1 border-t border-(--divider) px-4 py-3 [--standing-lead:1rem] [--standing-trail:1rem] first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4 sm:[--standing-lead:12rem] min-[45rem]:items-center ${
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
            const presentation = presentations.get(candidate.candidateId);
            if (!presentation) return null;
            const primary = candidate.candidateId === surfaceId;
            return (
              <DashboardFactRow
                key={candidate.candidateId}
                candidate={candidate}
                presentation={presentation}
                lane="standing"
                // The door is PINNED to the right edge of the family's facts cell
                // (#3459 item 2): `standing-stretch` is what gives every member's door
                // the same rail, and `pointer-events-none` on the door itself is why a
                // neighbour's rail never takes the pointer.
                surfaceClass={
                  presentation.href && (stacked || primary)
                    ? `standing-stretch ${primary ? "standing-primary " : ""}`
                    : ""
                }
                linkClass="sm:pr-32"
                className={
                  stacked ? "relative" : primary ? undefined : "z-10"
                }
              />
            );
          })}
        </ul>
      </dd>
      {/* Only plotted families reserve the trailing track. */}
      {series && <StandingSparkline series={series} />}
    </div>
  );
}

// Families in the order the RANKER handed them over. For the tier that is claim
// order; for the rest and the tail it is the registry's declaration order, which
// is what makes a glance-by-position row stay put while no claim moves.
function familiesInBand(
  placements: readonly StandingPlacement[]
): { family: StandingReadingFamily; members: StandingPlacement[] }[] {
  const groups: {
    family: StandingReadingFamily;
    members: StandingPlacement[];
  }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const placement of placements) {
    const existing = byKey.get(placement.standingFamilyKey);
    if (existing) {
      existing.members.push(placement);
      continue;
    }
    const family = STANDING_READING_ORDER.find(
      (entry) => entry.key === placement.standingFamilyKey
    );
    if (!family) continue;
    const group = { family, members: [placement] };
    byKey.set(placement.standingFamilyKey, group);
    groups.push(group);
  }
  return groups;
}

function BandRows({
  placements,
  presentations,
}: {
  placements: readonly StandingPlacement[];
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  return (
    <dl>
      {familiesInBand(placements).map(({ family, members }) => (
        <StandingFamilyRow
          key={family.key}
          family={family}
          members={members}
          presentations={presentations}
        />
      ))}
    </dl>
  );
}

export default function DashboardStandingCluster({
  placements,
  presentations,
}: {
  placements: readonly StandingPlacement[];
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  const inBand = (band: StandingBandKey) =>
    placements.filter((placement) => placement.standingBand === band);
  const attention = inBand("attention");
  const rest = inBand("rest");
  const tail = inBand("tail");
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
        className="band overflow-hidden rounded-xl border border-(--border) bg-surface"
        data-testid="dashboard-standing"
      >
        {/* THE ATTENTION TIER (#3548). Membership is a live claim — a behind
          target, a result that just turned notable, a pillar that moved, a
          bootstrap CTA on a profile that has never recorded — and the ranker
          decides it from the candidate's own rank reasons, so there is no id list
          here to keep in step. An empty tier renders NOTHING, header included. */}
        {attention.length > 0 && (
          <section
            aria-labelledby="dashboard-standing-attention"
            data-standing-band="attention"
            className="border-b border-(--divider) last:border-b-0"
          >
            <h3
              id="dashboard-standing-attention"
              className="band bg-amber-50 px-4 py-2 text-xs font-semibold tracking-wide text-amber-800 uppercase dark:bg-amber-950/40 dark:text-amber-300"
            >
              Attention
            </h3>
            <BandRows placements={attention} presentations={presentations} />
          </section>
        )}
        {SECTIONS.map((section) => {
          const members = rest.filter(
            (placement) => placement.standingSection === section.key
          );
          if (members.length === 0) return null;
          return (
            <section
              key={section.key}
              aria-labelledby={`dashboard-standing-${section.key}`}
              data-standing-section={section.key}
              data-standing-band="rest"
              className="border-b border-(--divider) last:border-b-0"
            >
              <h3
                id={`dashboard-standing-${section.key}`}
                className="band bg-(--ghost) px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
              >
                {section.label}
              </h3>
              <BandRows placements={members} presentations={presentations} />
            </section>
          );
        })}
        {/* THE QUIET TAIL (#3548). Everything static — a source that went dormant,
          a months-old result, a quiet pillar, a connect-a-source CTA past the
          cold-start cap — stays PRESENT and reachable, and stops occupying the
          open page. Native <details>, so the rows are hidden and not unmounted,
          in-page find still opens it, and the summary carries the expanded state
          without an aria attribute of our own. Nothing is remembered: the fold is
          computed from claims, never configured. */}
        {tail.length > 0 && (
          <Disclosure
            data-standing-band="tail"
            data-testid="dashboard-standing-tail"
          >
            <summary
              data-testid="dashboard-standing-tail-summary"
              className="band flex min-h-11 cursor-pointer list-none items-center bg-(--ghost) px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase marker:content-none dark:text-slate-400"
            >
              Quiet ({tail.length})
            </summary>
            <BandRows placements={tail} presentations={presentations} />
          </Disclosure>
        )}
      </div>
    </section>
  );
}
