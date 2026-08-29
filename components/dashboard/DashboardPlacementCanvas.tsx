import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import {
  placementsInLane,
  type DashboardEverythingGroup,
  type DashboardPlacement,
} from "@/lib/dashboard-relevance";
import type { AppRoute } from "@/lib/hrefs";
import NowStrip, { type NowStripCard } from "./NowStrip";
import AppBadge from "@/components/AppBadge";
import RememberedDetails from "@/components/RememberedDetails";
import DashboardAhead, { type DashboardAheadBucket } from "./DashboardAhead";
import DashboardStandingCluster, {
  DashboardFactRow,
  type DashboardStandingPresentation,
} from "./DashboardStandingCluster";

export interface DashboardPlacementCanvasProps {
  dateLabel: string;
  placements: readonly DashboardPlacement[];
  candidateNodes: ReadonlyMap<string, ReactNode>;
  /**
   * The row presentation for every fact that reports: Standing's members and, since
   * #3365, the Show-everything tail's Read / Understand / Setup entries, which render
   * through the SAME row renderer rather than a card of their own.
   */
  standingPresentations: ReadonlyMap<string, DashboardStandingPresentation>;
  aheadPresentations: ReadonlyMap<string, DashboardAheadPresentation>;
  attentionBadgeCount: number;
  illnessGroupNode?: ReactNode;
}

export interface DashboardAheadPresentation {
  label: string;
  detail?: string;
  href?: AppRoute;
}

// WHICH TAIL GROUPS REPORT (#3365). Read, Understand and Setup are indexes of facts,
// so they render as rows; Act is an offer to write and Active states is a situation
// that is running, and both keep a card. Cards act, lines report (#3077).
const ROW_GROUPS: ReadonlySet<DashboardEverythingGroup> = new Set([
  "read",
  "understand",
  "setup",
]);

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

// Consecutive row blocks share ONE bordered container, so the group reads as a single
// index rather than a stack of framed strips; a block that renders its members' nodes
// (a Show-everything entry that hosts a control, and therefore declares no row) breaks
// the run and sits between them in the ranker's order, unmoved.
function tailRuns(
  blocks: readonly MomentBlockModel[],
  rendersAsRow: (placement: EverythingPlacement) => boolean
): { rows: boolean; blocks: MomentBlockModel[] }[] {
  const runs: { rows: boolean; blocks: MomentBlockModel[] }[] = [];
  for (const block of blocks) {
    const rows = block.members.every(rendersAsRow);
    const last = runs.at(-1);
    if (last && last.rows === rows && rows) last.blocks.push(block);
    else runs.push({ rows, blocks: [block] });
  }
  return runs;
}

function MomentBlock({
  block,
  presentations,
}: {
  block: MomentBlockModel;
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  const moment = block.members
    .map((placement) => presentations.get(placement.candidate.candidateId)?.moment)
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
            presentation={
              presentations.get(placement.candidate.candidateId)!
            }
            lane="everything"
          />
        ))}
      </ul>
    </div>
  );
}

export default function DashboardPlacementCanvas({
  dateLabel,
  placements,
  candidateNodes,
  standingPresentations,
  aheadPresentations,
  attentionBadgeCount,
  illnessGroupNode,
}: DashboardPlacementCanvasProps) {
  // A REPORTING tail entry renders as a row and needs a row presentation; every other
  // placement renders its node. Read / Understand / Setup declare a row, so the fact
  // that a Show-everything entry HOSTS A CONTROL is the one thing that keeps it in a
  // card there — and that is a claim the page makes by declaring no row, not a
  // per-source branch here. Either way the entry must render: exact-once completeness
  // is a claim about what is ON SCREEN, so a candidate that has neither is a hard
  // failure rather than a silent omission.
  const rendersAsRow = (placement: DashboardPlacement) =>
    placement.lane === "everything" &&
    ROW_GROUPS.has(placement.everythingGroup) &&
    standingPresentations.get(placement.candidate.candidateId) != null;
  const missingNode = placements.find(
    (placement) =>
      placement.lane !== "standing" &&
      placement.lane !== "ahead" &&
      !rendersAsRow(placement) &&
      !(
        placement.lane === "now" &&
        placement.nowLayer === "illness" &&
        placement.candidate.episodeGroup != null
      ) &&
      candidateNodes.get(placement.candidate.candidateId) == null
  );
  if (missingNode) {
    throw new Error(
      `Missing dashboard candidate node for ${missingNode.candidate.candidateId} in ${missingNode.lane}`
    );
  }
  const missingAhead = placements.find(
    (placement) =>
      placement.lane === "ahead" &&
      aheadPresentations.get(placement.candidate.candidateId) == null
  );
  if (missingAhead)
    throw new Error(
      `Missing dashboard Ahead presentation for ${missingAhead.candidate.candidateId}`
    );

  const nodeFor = (placement: DashboardPlacement) => {
    const node = candidateNodes.get(placement.candidate.candidateId);
    if (node == null) return null;
    const { candidate } = placement;
    const engagement =
      candidate.relevance.kind === "profile-data"
        ? candidate.relevance.engagement
        : undefined;
    return (
      <div
        className="min-w-0"
        data-testid="dashboard-candidate"
        data-candidate-id={candidate.candidateId}
        data-fact-key={candidate.factKey}
        data-lane={placement.lane}
        data-kind={candidate.kind}
        data-engagement={engagement}
      >
        {node}
      </div>
    );
  };
  const nowPlacements = placementsInLane(placements, "now");
  const illnessPlacements = nowPlacements.filter(
    (placement) =>
      placement.nowLayer === "illness" &&
      placement.candidate.episodeGroup != null
  );
  if (illnessPlacements.length > 0 && illnessGroupNode == null) {
    throw new Error("Missing dashboard illness-group presentation");
  }
  const firstIllnessId = illnessPlacements[0]?.candidate.candidateId;
  const now = nowPlacements.flatMap((placement) => {
    if (placement.nowLayer === "illness" && placement.candidate.episodeGroup) {
      if (placement.candidate.candidateId !== firstIllnessId) return [];
      return [
        {
          id: "illness-group",
          // The group is one Now member standing for every open episode, and every
          // episode's own placement is a `state` — a situation that is running.
          kind: "state" as const,
          node: (
            <div data-testid="dashboard-illness-group">{illnessGroupNode}</div>
          ),
        } satisfies NowStripCard,
      ];
    }
    const node = nodeFor(placement);
    return node == null
      ? []
      : [
          {
            id: placement.candidate.candidateId,
            kind: placement.candidate.kind,
            node,
          } satisfies NowStripCard,
        ];
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
  const everything = placementsInLane(placements, "everything");
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
            primaryHref: (horizon.some(
              (placement) => placement.upcomingBand === "week"
            )
              ? "/upcoming#week"
              : "/upcoming#later") as AppRoute,
          }
        : {}),
      members: members.map((placement) => {
        const presentation = aheadPresentations.get(
          placement.candidate.candidateId
        )!;
        return {
          candidateId: placement.candidate.candidateId,
          factKey: placement.candidate.factKey,
          kind: placement.candidate.kind,
          ...presentation,
        };
      }),
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
        cards={now}
        dateLabel={dateLabel}
        bootstrapClaim={bootstrapClaim}
      />

      {standing.length > 0 && (
        <DashboardStandingCluster
          placements={standing}
          presentations={standingPresentations}
        />
      )}

      <DashboardAhead buckets={aheadBuckets} />

      {everything.length > 0 && (
        <RememberedDetails
          id="dashboard-all"
          className="group"
          testId="dashboard-all"
          summary={
            <summary className="mb-3 cursor-pointer list-none text-lg font-semibold text-slate-900 marker:content-none dark:text-slate-100">
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
            {everythingGroups.map(({ key: group, members }) => {
              return (
                <section key={group} aria-label={EVERYTHING_LABELS[group]}>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                    {EVERYTHING_LABELS[group]}
                  </h3>
                  <div
                    className="grid grid-cols-1 gap-3"
                    data-testid={`dashboard-everything-${group}`}
                  >
                    {ROW_GROUPS.has(group)
                      ? tailRuns(momentBlocks(members), rendersAsRow).map(
                          (run) =>
                            run.rows ? (
                              <div
                                key={run.blocks[0].key}
                                className="band overflow-hidden rounded-xl border border-(--border) bg-surface"
                              >
                                {run.blocks.map((block) => (
                                  <MomentBlock
                                    key={block.key}
                                    block={block}
                                    presentations={standingPresentations}
                                  />
                                ))}
                              </div>
                            ) : (
                              <Fragment key={run.blocks[0].key}>
                                {run.blocks.flatMap((block) =>
                                  block.members.map((placement) => (
                                    <Fragment
                                      key={placement.candidate.candidateId}
                                    >
                                      {nodeFor(placement)}
                                    </Fragment>
                                  ))
                                )}
                              </Fragment>
                            )
                        )
                      : members.map((placement) => (
                          <Fragment key={placement.candidate.candidateId}>
                            {nodeFor(placement)}
                          </Fragment>
                        ))}
                  </div>
                </section>
              );
            })}
          </div>
        </RememberedDetails>
      )}
    </div>
  );
}
