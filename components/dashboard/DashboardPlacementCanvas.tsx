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
  type DashboardStandingPresentation,
} from "./DashboardStandingCluster";

export interface DashboardPlacementCanvasProps {
  dateLabel: string;
  placements: readonly DashboardPlacement[];
  candidateNodes: ReadonlyMap<string, ReactNode>;
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

export default function DashboardPlacementCanvas({
  dateLabel,
  placements,
  candidateNodes,
  standingPresentations,
  aheadPresentations,
  attentionBadgeCount,
  illnessGroupNode,
}: DashboardPlacementCanvasProps) {
  const missingNode = placements.find(
    (placement) =>
      placement.lane !== "standing" &&
      placement.lane !== "ahead" &&
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
      <NowStrip cards={now} dateLabel={dateLabel} />

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
                  <div className="grid grid-cols-1 gap-3">
                    {members.map((placement) => (
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
