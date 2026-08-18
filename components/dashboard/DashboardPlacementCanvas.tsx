import { Fragment, type ComponentProps, type ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import DashboardGrid, { type GridWidget } from "./DashboardGrid";
import NowStrip, { type NowStripCard } from "./NowStrip";
import {
  visibleDashboardPlacements,
  type DashboardPlacement,
} from "@/lib/dashboard-relevance";

export interface DashboardPlacementCanvasProps {
  profileId: number;
  dateLabel: string;
  placements: readonly DashboardPlacement[];
  placementNodes: ReadonlyMap<string, ReactNode>;
  gridWidgets: GridWidget[];
  saveAction: ComponentProps<typeof DashboardGrid>["saveAction"];
}

// The sole dashboard rendering boundary (#3080). The page gathers facts and
// constructs nodes, but this component can render a node only by following a
// placement's nodeKey. It deliberately accepts no children or loose ReactNode
// prop, so a page-level `rogueNode` has no route around the manifest.
export default function DashboardPlacementCanvas({
  profileId,
  dateLabel,
  placements,
  placementNodes,
  gridWidgets,
  saveAction,
}: DashboardPlacementCanvasProps) {
  const placementNode = (placement: DashboardPlacement): ReactNode =>
    placementNodes.get(placement.nodeKey) ?? null;
  const priorityPlacements = visibleDashboardPlacements(placements, "priority");
  const priorityById = new Map(
    priorityPlacements.map((placement) => [placement.placementId, placement])
  );
  const priorityNode = (placementId: string): ReactNode => {
    const placement = priorityById.get(placementId);
    return placement ? placementNode(placement) : null;
  };
  const nowPlacements = visibleDashboardPlacements(placements, "now");
  const nowPlacementIds = nowPlacements.map(
    (placement) => placement.placementId
  );
  const nowStripCards: NowStripCard[] = nowPlacements
    .map((placement) => ({
      id: placement.placementId,
      node: placementNode(placement),
    }))
    .filter((card): card is NowStripCard => card.node != null);
  const preGridPlacements = visibleDashboardPlacements(placements, "pre-grid");
  const widgetById = new Map(gridWidgets.map((widget) => [widget.id, widget]));
  const rankedGridWidgets = placements
    .filter((placement) => placement.currentPlacement === "grid")
    .sort(
      (a, b) =>
        a.currentOrder - b.currentOrder ||
        a.placementId.localeCompare(b.placementId)
    )
    .map((placement) => widgetById.get(placement.placementId))
    .filter((widget): widget is GridWidget => widget != null);

  return (
    <div>
      {/* Desktop only (issue #1413, section C): on a phone the nav already says
          where you are. The date survives below `md` on the Now strip. */}
      <div className="hidden md:block">
        <PageHeader
          title="Dashboard"
          subtitle={`Today is ${dateLabel} — here's your health at a glance.`}
        />
      </div>
      <div
        data-testid="dashboard-priority-row"
        className={`mb-6 grid min-w-0 items-start gap-6 ${priorityById.has("illness-hero") ? "xl:grid-cols-2" : ""}`}
      >
        {priorityNode("illness-hero")}
        <div className="min-w-0">{priorityNode("needs-attention")}</div>
      </div>
      <NowStrip cards={nowStripCards} dateLabel={dateLabel} />
      {preGridPlacements.map((placement) => (
        <Fragment key={placement.placementId}>
          {placementNode(placement)}
        </Fragment>
      ))}
      <DashboardGrid
        key={profileId}
        widgets={rankedGridWidgets}
        promoted={nowPlacementIds}
        saveAction={saveAction}
      />
    </div>
  );
}
