import { Fragment, type ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import {
  placementsInLane,
  type DashboardCandidateKind,
  type DashboardPlacement,
} from "@/lib/dashboard-relevance";
import NowStrip, { type NowStripCard } from "./NowStrip";
import AppBadge from "@/components/AppBadge";
import DashboardStandingCluster, {
  type DashboardStandingPresentation,
} from "./DashboardStandingCluster";

export interface DashboardPlacementCanvasProps {
  dateLabel: string;
  placements: readonly DashboardPlacement[];
  candidateNodes: ReadonlyMap<string, ReactNode>;
  standingPresentations: ReadonlyMap<string, DashboardStandingPresentation>;
  attentionBadgeCount: number;
}

const EVERYTHING_LABELS: Record<DashboardCandidateKind, string> = {
  action: "Actions",
  statement: "Updates",
  state: "Current state",
  reading: "More readings",
};

export default function DashboardPlacementCanvas({
  dateLabel,
  placements,
  candidateNodes,
  standingPresentations,
  attentionBadgeCount,
}: DashboardPlacementCanvasProps) {
  const missingNode = placements.find(
    (placement) =>
      placement.lane !== "standing" &&
      candidateNodes.get(placement.candidate.candidateId) == null
  );
  if (missingNode) {
    throw new Error(
      `Missing dashboard candidate node for ${missingNode.candidate.candidateId} in ${missingNode.lane}`
    );
  }

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
  const now = placementsInLane(placements, "now").flatMap((placement) => {
    const node = nodeFor(placement);
    return node == null
      ? []
      : [{ id: placement.candidate.candidateId, node } satisfies NowStripCard];
  });
  const standing = placementsInLane(placements, "standing");
  const everything = placementsInLane(placements, "everything");
  const everythingKinds: DashboardCandidateKind[] = [
    "action",
    "statement",
    "state",
    "reading",
  ];

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

      {everything.length > 0 && (
        <section aria-labelledby="dashboard-everything-title">
          <h2
            id="dashboard-everything-title"
            className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            Everything
          </h2>
          <div className="space-y-6" data-testid="dashboard-everything">
            {everythingKinds.map((kind) => {
              const members = everything.filter(
                (placement) => placement.candidate.kind === kind
              );
              if (members.length === 0) return null;
              return (
                <section key={kind} aria-label={EVERYTHING_LABELS[kind]}>
                  <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                    {EVERYTHING_LABELS[kind]}
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
        </section>
      )}
    </div>
  );
}
