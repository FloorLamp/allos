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
  type StandingRenderedBand,
  type StandingReadingFamily,
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
  /**
   * THE MOMENT THIS FACT CAME FROM (#3365), printed ONCE as the header of the tail
   * block its same-`groupKey` siblings fold into — "Weekly recap · Aug 23–29" over
   * six lines instead of six identical card headers. It is a label on the fold, never
   * a placement: the block exists only because its atoms placed, and an atom promoted
   * to another lane simply leaves the block with one row fewer. Every member of one
   * group declares the same moment; the canvas reads the first that has one.
   */
  moment?: { title: string; href?: AppRoute };
  /**
   * THE CONTROL SLOT (#4076). The trailing cell of the one row grammar, holding at
   * most TWO controls at the one 34px `--control-box` height — the snooze/dismiss
   * menu, a "Mark taken", a finding's Dismiss. Cards left `/` entirely, and this is
   * where their writes landed: the ruling sanctions this slot as part of THE one
   * shape rather than as a second shape of the row (#3365 declined it as the
   * latter). A row with a control is NOT link-wrapped — see below — because a
   * `<form>` inside an `<a>` is invalid markup, which is the reason the writes had
   * to stay in cards until now.
   */
  control?: ReactNode;
}

// The door's label: the DESTINATION's own name, taken from the one list that already
// maps a route to what it is called (lib/recent-pages TRACKED_PAGES, which also cuts
// the `#body` fragment — a section is a position on a page, never a different page).
// Nothing is invented here: an untracked href simply gets no door, which is the honest
// answer when the app has no name for where the row goes.
function doorLabel(href: AppRoute): string | null {
  return trackedPageFor(href)?.label ?? null;
}

// THE ROW. ONE renderer for every fact the dashboard reports, in EVERY zone — Now,
// Standing, Ahead and the Show-everything tail (#4076). Cards-act/lines-report
// (#3077) is dead as a rendering rule: there is no second grammar left for a zone to
// choose, so identity comes from the label column and the block header rather than
// from a glyph or a frame, and what a row EARNS goes in the trailing slot (a control,
// a sparkline, a door). The caller supplies only what its lane owns: Standing's door
// rail and stacking classes, every other lane's nothing.
export function DashboardFactRow({
  candidate,
  presentation,
  lane,
  surfaceClass = "",
  linkClass = "",
  className,
  "data-motion": dataMotion,
}: {
  candidate: DashboardPlacement["candidate"];
  presentation: DashboardStandingPresentation;
  lane: DashboardPlacement["lane"];
  surfaceClass?: string;
  linkClass?: string;
  className?: string;
  /**
   * Now's witnessed-arrival mark (#3253 decision 4), which only the client can
   * decide. It mirrors the motion class exactly, so a reduced-motion viewer gets
   * neither — "nothing animated" stays one assertion rather than a guess about
   * computed styles.
   */
  "data-motion"?: "promote";
}) {
  const engagement =
    candidate.relevance.kind === "profile-data"
      ? candidate.relevance.engagement
      : undefined;
  // WHERE THE DOOR GOES WHEN THE ROW CANNOT BE ONE (see the link-wrap suppression
  // below). EXACTLY ONE element carries the href: the row's own CTA words if it has
  // any — "Fix it", "Log", "Continue" — because those name the destination better
  // than anything else on the row; otherwise its identity — the label, or on a row
  // with no label of its own (a `single` family's one member, named by the family)
  // the value, since a stale vital that earns a door (#4757) must not lose its history
  // with it. Two links to one page on one row is a second tab stop saying the same
  // thing.
  const unwrapped = presentation.control != null && presentation.href != null;
  const identityLink =
    unwrapped && !presentation.actionLabel ? presentation.href : undefined;
  const actionLink = unwrapped && presentation.actionLabel;
  const identityLinkClass =
    "hover:text-brand-700 hover:underline dark:hover:text-brand-400";
  const content = (
    <>
      {presentation.label && (
        // The row's IDENTITY — what the reading is, as opposed to what it
        // says. Named so a layout guard can assert a long value never costs a
        // Standing reading its name (#2614), which is a claim about this span
        // rather than about any one family.
        <span
          data-testid="standing-label"
          className={
            presentation.value == null
              ? "text-sm text-slate-900 dark:text-slate-100"
              : "text-xs text-slate-500 dark:text-slate-400"
          }
        >
          {identityLink ? (
            <Link href={identityLink} className={identityLinkClass}>
              {presentation.label}
            </Link>
          ) : (
            presentation.label
          )}
        </span>
      )}
      {presentation.value != null && (
        <span
          data-testid="standing-value"
          className="font-semibold tabular-nums text-slate-900 dark:text-slate-100"
        >
          {identityLink && !presentation.label ? (
            <Link href={identityLink} className={identityLinkClass}>
              {presentation.value}
            </Link>
          ) : (
            presentation.value
          )}
        </span>
      )}
      {presentation.detail != null && (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {presentation.detail}
        </span>
      )}
      {presentation.actionLabel &&
        (actionLink ? (
          <Link
            href={presentation.href!}
            className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            {presentation.actionLabel}
          </Link>
        ) : (
          <span className="text-xs font-medium text-brand-700 dark:text-brand-400">
            {presentation.actionLabel}
          </span>
        ))}
    </>
  );
  const rowClass =
    "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm";
  // The door: where this row goes, revealed on hover and on keyboard focus alike.
  // No door on a row that is not a link, and no door where the app has no name for
  // the destination — an untracked href is the honest silence.
  const door = presentation.href ? doorLabel(presentation.href) : null;
  const rowDisclosure = presentation.disclosure;
  // LINK-WRAP SUPPRESSION (#4076). A row that hosts a control cannot be an anchor
  // around its own contents — the control is a `<form>`/`<button>`, and nesting
  // either inside an `<a>` is invalid markup that browsers reparent. The row's
  // destination is not lost: the label carries it as an ordinary link, which is also
  // the only element on the row whose words name where it goes.
  const control = presentation.control;
  const linked =
    control == null && presentation.href ? (
      door ? (
        <StandingDestinationLink
          href={presentation.href}
          className={`${surfaceClass}standing-row ${rowClass} ${rowDisclosure ? "" : linkClass} hover:text-brand-700 dark:hover:text-brand-400`}
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
  const body = linked ? (
    rowDisclosure ? (
      <div className={`flex min-w-0 items-center ${linkClass}`}>
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
  );
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
      data-motion={dataMotion}
    >
      {control == null ? (
        body
      ) : (
        // The trailing cell. `items-center` and not `items-baseline`: a control is a
        // box, and aligning a 34px box on the text baseline hangs it below the row.
        <div className="flex min-w-0 items-center gap-2">
          {body}
          <div
            data-testid="dashboard-row-controls"
            className="ml-auto flex shrink-0 items-center gap-1"
          >
            {control}
          </div>
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
                className={stacked ? "relative" : primary ? undefined : "z-10"}
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
  const inBand = (band: StandingRenderedBand) =>
    placements.filter((placement) => placement.standingBand === band);
  const attention = inBand("attention");
  const rest = inBand("rest");
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
            className="border-b border-l-4 border-(--divider) border-l-amber-500 bg-amber-50 last:border-b-0 dark:border-l-amber-400 dark:bg-amber-950"
          >
            <h3
              id="dashboard-standing-attention"
              className="band px-4 py-2 text-xs font-semibold tracking-wide text-amber-800 uppercase dark:text-amber-200"
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
        {/* NO THIRD BAND (#4232, narrowing #3548). Everything static — a source that
          went dormant, a months-old result, a quiet pillar, a connect-a-source CTA
          past the cold-start cap — is not claimed by Standing at all now, so it
          stays PRESENT and reachable in the page's ONE bottom fold instead of behind
          a second drawer of its own. Standing is the glance surface: attention and
          rest, always open. */}
      </div>
    </section>
  );
}
