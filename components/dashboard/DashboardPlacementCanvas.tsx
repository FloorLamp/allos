import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import {
  everythingTail,
  placementsInLane,
  type DashboardEverythingGroup,
  type DashboardPlacement,
} from "@/lib/dashboard-relevance";
import NowStrip, { type NowStripRow, type NowSubjectLabel } from "./NowStrip";
import AppBadge from "@/components/AppBadge";
import RememberedDetails from "@/components/RememberedDetails";
import Disclosure from "@/components/Disclosure";
import DashboardAhead, { type DashboardAheadBucket } from "./DashboardAhead";
import DashboardStandingCluster, {
  DashboardFactRow,
  type DashboardStandingPresentation,
  type StandingFamilyDrawing,
} from "./DashboardStandingCluster";
import type { StandingFamilyKey } from "@/lib/dashboard-standing";

export interface DashboardPlacementCanvasProps {
  dateLabel: string;
  placements: readonly DashboardPlacement[];
  /**
   * The row presentation for EVERY fact the dashboard draws. Since #4076 there is no
   * second map beside it: cards left `/`, so a placement that renders declares a row
   * and nothing else, and the canvas fails loudly for one that declares neither
   * (exact-once completeness is a claim about what is ON SCREEN).
   */
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
  /**
   * THE DRAWING BELONGS TO THE FAMILY (#4969), resolved once per family
   * alongside `presentations` rather than hung off whichever member happened to
   * carry it. Standing is the only lane with families, so this is consulted
   * there and nowhere else. Optional: a caller with no plotted family (most
   * fixtures) may omit it rather than pass an empty map at every call site.
   */
  drawings?: ReadonlyMap<StandingFamilyKey, StandingFamilyDrawing>;
  /**
   * AHEAD SAYS WHEN, NOT WHAT (#4076). One row RENDERER serves every zone, but Ahead
   * is a schedule: its facts column states when a thing is due, where the same
   * candidate drawn in Now or in the tail states the item's own content — the
   * biomarker retest sentence, "Vitamin D3 · 2000 IU". A candidate places in exactly
   * one lane, and the lane is not known when the page builds these, so the page
   * declares both readings and the canvas picks by lane. Reusing one for the other
   * silently deletes the sentence a person came to read.
   */
  aheadPresentations: ReadonlyMap<string, DashboardStandingPresentation>;
  attentionBadgeCount: number;
  illnessGroupNode?: ReactNode;
  /**
   * WHO EACH NOW SUBJECT IS (#4752 item 6), keyed by the ranker's subject key. Only
   * consulted when the ranker actually grouped, so a single-subject dashboard can
   * pass whatever it likes and still render no labels.
   */
  nowSubjects?: ReadonlyMap<string, NowSubjectLabel>;
}

const EVERYTHING_LABELS: Record<DashboardEverythingGroup, string> = {
  act: "Act",
  read: "Read",
  understand: "Understand",
  setup: "Setup",
  "active-states": "Active states",
};

function groupsInPlacementOrder<Item, Key>(
  items: readonly Item[],
  keyFor: (item: Item) => Key
): { key: Key; members: Item[] }[] {
  const groups: { key: Key; members: Item[] }[] = [];
  const byKey = new Map<Key, Item[]>();
  for (const item of items) {
    const key = keyFor(item);
    let members = byKey.get(key);
    if (!members) {
      members = [];
      byKey.set(key, members);
      groups.push({ key, members });
    }
    members.push(item);
  }
  return groups;
}

type EverythingPlacement = Extract<DashboardPlacement, { lane: "everything" }>;

interface MomentBlockModel {
  key: string;
  groupKey: string | null;
  members: readonly EverythingPlacement[];
}

// THE FOLD (#3365). Same-origin atoms — the ones the candidate model already keys
// together with `groupKey`, which is where "atoms group by moment, not domain" is
// already written down — print ONE header and one door over their facts instead of
// one identical card each. Six "Weekly recap" cards carrying one line apiece become
// six lines under "Weekly recap · Aug 23–29".
//
// It is a FOLD AND NEVER AN OWNER OF PLACEMENT: the members are whatever the ranker
// put in this group, in the ranker's order, and the block's key is the group's own.
// A sibling promoted to Now simply leaves one row fewer behind; nothing here can
// admit, drop, reorder or cap anything. An ungrouped atom is a block of one.
//
// SINCE #4076 IT SERVES EVERY TAIL GROUP, Act and Active states included: with cards
// gone there is no branch left for a group to take, so the statement families that
// could never fold while they rendered cards (coaching observations, data-quality
// findings) fold here on the shared `groupKey` their builder now passes.
function momentBlocks(
  members: readonly EverythingPlacement[]
): MomentBlockModel[] {
  // An ungrouped atom keys on its own PLACEMENT OBJECT, so it can never collide with
  // a real groupKey however either is spelled.
  return groupsInPlacementOrder(
    members,
    (placement) => placement.candidate.groupKey ?? placement
  ).map(({ members: block }) => ({
    key: block[0].candidate.candidateId,
    groupKey: block[0].candidate.groupKey,
    members: block,
  }));
}

function MomentBlock({
  block,
  presentations,
}: {
  block: MomentBlockModel;
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  const moment = block.members
    .map(
      (placement) => presentations.get(placement.candidate.candidateId)?.moment
    )
    .find((entry) => entry != null);
  const door = moment?.href;
  return (
    <div
      className="border-t border-(--divider) px-4 py-3 first:border-t-0"
      data-moment-key={block.groupKey ?? undefined}
    >
      {moment && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {moment.title}
          </h4>
          {door && (
            <Link
              href={door}
              className="shrink-0 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              View
            </Link>
          )}
        </div>
      )}
      <ul className="flex min-w-0 flex-col gap-1.5">
        {block.members.map((placement) => (
          <DashboardFactRow
            key={placement.candidate.candidateId}
            candidate={placement.candidate}
            presentation={presentations.get(placement.candidate.candidateId)!}
            lane="everything"
            // The row's hover door is `absolute right-0` and pins to the nearest
            // positioned ancestor. Standing provides its facts cell; here the row's
            // own box is the rail — without it the door escapes to the viewport
            // edge, and its resting 4px translate widens the whole page.
            className="relative"
          />
        ))}
      </ul>
    </div>
  );
}

// THE BAND CAP (#4065, owner ruling 2026-09-03 "fold with a cap"). Understand and
// Setup are the tail's bulk — 74 statements and 65-87 setup rows measured across the
// seeded personas, most saying today what they said yesterday. Nothing is dropped:
// every block a band computes is still drawn, admission stays total, and a row
// leaves only by resolving (no age-based decay is added here or anywhere).
//
// THE CAP UNIT IS THE MOMENT BLOCK, NOT THE UNDERLYING CANDIDATE. A family that
// already shares one `groupKey` — coaching observations, data-quality findings —
// reads as ONE entry under ONE header before this ruling and must keep doing so
// after it: splitting a block across open/folded would print its header twice,
// which is the exact duplicate #4076 exists to forbid ("no two blocks share a
// title"). So three BLOCKS stay open, newest first, and the block that would push a
// fourth open goes to the fold whole, however many rows it carries — which is also
// why the fold's count below is a ROW count, not a block count: a folded family of
// eight must say "8 more", never "1 more", or the amount itself would be hiding.
const EVERYTHING_BAND_CAP = 3;
const CAPPED_EVERYTHING_GROUPS: ReadonlySet<DashboardEverythingGroup> = new Set(
  ["understand", "setup"]
);

function EverythingBand({
  group,
  members,
  presentations,
}: {
  group: DashboardEverythingGroup;
  members: readonly EverythingPlacement[];
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  const blocks = momentBlocks(members);
  // NEWEST FIRST. Neither band carries a real timestamp per block — a coaching
  // observation and a setup item are placed by the ranker's own order
  // (`compareSource`/dismissal-fatigue rerank for findings, declared step order for
  // setup), not by when the underlying fact appeared — so there is no clock to sort
  // by without minting one, which the ruling's "no new decay" and this repo's
  // "types over guards" doctrine both argue against. The band's OWN order is kept as
  // the stand-in: it already pushes repeatedly-dismissed findings toward the back
  // (`routineOrder`, lib/dismissal-fatigue.ts), so keeping the FRONT open is not an
  // arbitrary truncation — it is "whatever the ranker considers current" open and
  // "whatever it has already downranked" folded, which is the same direction "newest
  // first" points in every band that does have a real order today.
  const capped =
    CAPPED_EVERYTHING_GROUPS.has(group) && blocks.length > EVERYTHING_BAND_CAP;
  const openBlocks = capped ? blocks.slice(0, EVERYTHING_BAND_CAP) : blocks;
  const foldedBlocks = capped ? blocks.slice(EVERYTHING_BAND_CAP) : [];
  const foldedRowCount = foldedBlocks.reduce(
    (sum, block) => sum + block.members.length,
    0
  );
  return (
    <div
      className="band overflow-hidden rounded-xl border border-(--border) bg-surface px-0!"
      data-testid={`dashboard-everything-${group}`}
    >
      {openBlocks.map((block) => (
        <MomentBlock
          key={block.key}
          block={block}
          presentations={presentations}
        />
      ))}
      {foldedBlocks.length > 0 && (
        // A SECOND INSTANCE OF THE APP'S ONE FOLD (#4232), never a second kind of
        // one. Same `<Disclosure>` primitive, same motion, same border-top rhythm
        // MomentBlock already uses for a new entry in this band — a reader who has
        // learned what a chevron-and-count means once does not learn it again here.
        //
        // STATELESS, ON PURPOSE. `dashboard-all` remembers because it is the daily
        // routine remainder; this fold gates findings and setup prompts, which
        // `lib/disclosure-memory.ts`'s own allowlist holds OUT of memory by class —
        // a remembered-open findings fold pre-opens a wall the reader did not ask
        // for on this visit. So this is the app's shared `<Disclosure>` used
        // directly, uncontrolled, always closed on arrival, never routed through
        // `RememberedDetails` or the `DisclosureId` registry.
        <Disclosure
          data-testid={`dashboard-everything-${group}-fold`}
          className="border-t border-(--divider)"
        >
          <summary
            data-testid={`dashboard-everything-${group}-fold-summary`}
            className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-slate-600 marker:content-none dark:text-slate-300"
          >
            <span
              aria-hidden
              className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none"
            >
              ›
            </span>
            {foldedRowCount} more
          </summary>
          {foldedBlocks.map((block) => (
            <MomentBlock
              key={block.key}
              block={block}
              presentations={presentations}
            />
          ))}
        </Disclosure>
      )}
    </div>
  );
}

const NO_DRAWINGS: ReadonlyMap<StandingFamilyKey, StandingFamilyDrawing> =
  new Map();

export default function DashboardPlacementCanvas({
  dateLabel,
  placements,
  presentations,
  drawings = NO_DRAWINGS,
  aheadPresentations,
  attentionBadgeCount,
  illnessGroupNode,
  nowSubjects,
}: DashboardPlacementCanvasProps) {
  const rowFor = (placement: DashboardPlacement) =>
    (placement.lane === "ahead" ? aheadPresentations : presentations).get(
      placement.candidate.candidateId
    );
  // THE TAIL'S SPLIT (#3366): a placement the tail does not draw owes no
  // presentation — its page is drawn instead, in the app's own nav. Since #4076 the
  // tail draws no door row for it either (owner: the Elsewhere section is "utterly
  // useless"), so the guarantee that nothing is silently hidden is asserted where it
  // can actually be checked — the placement manifest tier — rather than by a reader
  // scrolling a list of page names they already have a sidebar for.
  const everything = everythingTail(placements);
  const drawn = new Set(
    everything.map((placement) => placement.candidate.candidateId)
  );
  const missing = placements.find(
    (placement) =>
      !(
        placement.lane === "everything" &&
        !drawn.has(placement.candidate.candidateId)
      ) &&
      !(
        placement.lane === "now" &&
        placement.nowLayer === "illness" &&
        placement.candidate.episodeGroup != null
      ) &&
      rowFor(placement) == null
  );
  if (missing) {
    throw new Error(
      `Missing dashboard row presentation for ${missing.candidate.candidateId} in ${missing.lane}`
    );
  }

  const nowPlacements = placementsInLane(placements, "now");
  const illnessPlacements = nowPlacements.filter(
    (placement) =>
      placement.nowLayer === "illness" &&
      placement.candidate.episodeGroup != null
  );
  if (illnessPlacements.length > 0 && illnessGroupNode == null) {
    throw new Error("Missing dashboard illness-group presentation");
  }
  // The illness group stands where its FIRST episode placed, and every other episode
  // placement leaves the strip (their facts are inside the cockpit).
  const firstIllnessId = illnessPlacements[0]?.candidate.candidateId;
  // WHOSE NAME MAY STAND OVER THE ILLNESS GROUP (#4752 item 6). The group is ONE
  // container holding every ill profile's cockpit, so a subject label above it is
  // true only while a single subject is ill; with two, the first one's name would
  // sit over another patient's controls, which is exactly the mis-attribution
  // #531/#534 made the per-cockpit name a safety feature to prevent. Two ill
  // profiles therefore draw NO label here and are named where they always were —
  // on each cockpit's own header, inside the group.
  const oneIllSubject =
    new Set(illnessPlacements.map((placement) => placement.nowSubject)).size ===
    1;
  const now = nowPlacements.flatMap((placement): NowStripRow[] => {
    const subject =
      placement.nowSubject == null
        ? undefined
        : nowSubjects?.get(placement.nowSubject);
    const grouped =
      placement.nowLayer === "illness" &&
      placement.candidate.episodeGroup != null;
    if (!grouped)
      return [
        {
          id: placement.candidate.candidateId,
          subject,
          candidate: placement.candidate,
          presentation: presentations.get(placement.candidate.candidateId)!,
        },
      ];
    return placement.candidate.candidateId === firstIllnessId
      ? [
          {
            id: "illness-group",
            subject: oneIllSubject ? subject : undefined,
            node: illnessGroupNode,
          },
        ]
      : [];
  });
  const standing = placementsInLane(placements, "standing");
  // Owner ruling (#3548, cold start): "Nothing needs you." can never render on a
  // profile whose attention tier is the getting-started list. A never-recorded
  // family's CTA in the tier IS that claim, and it is the only one that suppresses
  // the sentence — #3245's accepted cost stands, so a behind target out of its
  // moment still leaves a genuinely settled day settled.
  const bootstrapClaim = standing.some(
    (placement) =>
      placement.standingBand === "attention" &&
      placement.candidate.relevance.kind === "profile-data" &&
      placement.candidate.relevance.presence === "never"
  );
  const ahead = placementsInLane(placements, "ahead");
  const aheadBuckets = groupsInPlacementOrder(
    ahead,
    (placement) => placement.aheadBucket
  ).map(({ key, members }): DashboardAheadBucket => {
    const horizon = members.filter(
      (placement) => placement.aheadBucket === "horizon"
    );
    return {
      key,
      label: key === "later-today" ? "Later today" : "This week and later",
      ...(key === "horizon"
        ? {
            primaryHref: horizon.some(
              (placement) => placement.upcomingBand === "week"
            )
              ? ("/upcoming#week" as const)
              : ("/upcoming#later" as const),
          }
        : {}),
      members: members.map((placement) => ({
        candidate: placement.candidate,
        presentation: aheadPresentations.get(placement.candidate.candidateId)!,
      })),
    };
  });
  const everythingGroups = groupsInPlacementOrder(
    everything,
    (placement) => placement.everythingGroup
  );

  return (
    <div>
      <AppBadge count={attentionBadgeCount} />
      <div className="hidden md:block">
        <PageHeader
          title="Dashboard"
          subtitle={`Today is ${dateLabel} — here's your health at a glance.`}
        />
      </div>
      <NowStrip
        rows={now}
        dateLabel={dateLabel}
        bootstrapClaim={bootstrapClaim}
      />

      {standing.length > 0 && (
        <DashboardStandingCluster
          placements={standing}
          presentations={presentations}
          drawings={drawings}
        />
      )}

      <DashboardAhead buckets={aheadBuckets} />

      {everything.length > 0 && (
        <RememberedDetails
          id="dashboard-all"
          className="group"
          testId="dashboard-all"
          summary={
            // THE OUTER FOLD CONTROL (#4232), so it carries the phone tap floor
            // the retired Quiet summary carried. Merging the two folds moved every
            // dormant line, quiet pillar, quiet result and out-ranked setup row
            // behind THIS control; at its inherited 28px it was the one tap
            // standing between a phone reader and all of them.
            //
            // #4065 nests up to two more `<Disclosure>`s under this one (per
            // `EverythingBand`, above) rather than opening a second kind of
            // control — this stays the page's one FOLD MECHANISM, just used at
            // two depths, the way #4232 already used it at every tail group.
            <summary
              // The UX census must click this before the tail is in any picture at
              // all, and the `<details>` takes its own testid through a prop — which
              // no rename guard can pin, and is how the last registration went stale
              // (scripts/ux-census-routes.mjs).
              data-testid="dashboard-all-summary"
              className="fold-control mb-3 flex list-none items-center text-lg font-semibold text-slate-900 marker:content-none dark:text-slate-100"
            >
              <span
                aria-hidden
                className="mr-2 inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none"
              >
                ›
              </span>
              Show everything
            </summary>
          }
        >
          <div className="space-y-6" data-testid="dashboard-all-contents">
            {everythingGroups.map(({ key: group, members }) => (
              <section key={group} aria-label={EVERYTHING_LABELS[group]}>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  {EVERYTHING_LABELS[group]}
                </h3>
                <EverythingBand
                  group={group}
                  members={members}
                  presentations={presentations}
                />
              </section>
            ))}
          </div>
        </RememberedDetails>
      )}
    </div>
  );
}
