"use client";

import { useRouter } from "next/navigation";
import { IconPencil } from "@tabler/icons-react";
import {
  useActivityEditor,
  useEditorDock,
} from "@/components/ActivityEditorProvider";
import TrainingLogCard from "../TrainingLogCard";
import type { TrainingLogCardData } from "@/lib/training-log-card";
import type { ActivityDetailSibling } from "@/lib/training-activity-detail";
import type { UnitPrefs } from "@/lib/settings";

// The dock is worth a second column's width. Below this the provider's overlay
// is the better editor host (same fallback the Training Log uses at its own
// breakpoint) — the page column at phone width can't hold the form usably.
const ACTIVITY_PAGE_DOCK_QUERY = "(min-width: 768px)";

// The activity page's client host for the record card (#2870). The record IS
// the Training Log card — one component, another host (#2897's three-host rule
// starts here). This wrapper exists for the client seams the page needs:
// exercise-name doors (names deep-link their Analyze pages), and — step 2 —
// the EDITOR DOCK: the page registers itself as the provider's dock target, so
// "Edit" opens the full ActivityForm IN PLACE below the record, bringing the
// autosave machinery and its edit-lock banner along instead of forking a
// second editing surface. Per-field tap-in commits follow with #2866's
// repaired retry leg (#2870 step 3's prerequisite discipline).
export default function ActivityRecord({
  card,
  siblings,
  units,
  canWrite,
}: {
  card: TrainingLogCardData;
  siblings: ActivityDetailSibling[];
  units: UnitPrefs;
  canWrite: boolean;
}) {
  const router = useRouter();
  const { openEdit } = useActivityEditor();
  // Scoped to THIS record's id: the page dock hosts only its own activity's
  // edits — a global "New activity" or a live resume stays in the overlay
  // instead of portaling an unrelated form under this record (the hook and the
  // provider's registerDock own the shared registration discipline).
  const { dockRef } = useEditorDock(ACTIVITY_PAGE_DOCK_QUERY, card.activity.id);

  return (
    <div>
      {canWrite && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            data-testid="activity-page-edit"
            onClick={() => openEdit(card.activity)}
            className="btn-ghost inline-flex items-center gap-1.5 text-sm"
          >
            <IconPencil className="h-4 w-4" aria-hidden /> Edit
          </button>
        </div>
      )}
      <TrainingLogCard
        activity={card.activity}
        timeText={card.timeText}
        durationText={card.durationText}
        distanceText={card.distanceText}
        speedText={card.speedText}
        heartRateText={card.heartRateText}
        calorieText={card.calorieText}
        metrics={card.metrics}
        gear={card.gear}
        parts={card.parts}
        fault={card.fault}
        provenance={card.provenance}
        routePolyline={card.routePolyline}
        mergeSiblings={siblings}
        keeperLabel={card.provenance.label}
        foldValues={card.foldValues}
        units={units}
        videos={card.videos}
        canWrite={canWrite}
        onSelectExercise={(name) =>
          router.push(
            `/training?tab=analyze&kind=strength&item=${encodeURIComponent(name)}`
          )
        }
      />
      {/* The editor's in-page home: the provider portals ActivityForm here
          while an edit is open (empty and cost-free otherwise). */}
      <div ref={dockRef} data-testid="activity-page-dock" className="mt-4" />
    </div>
  );
}
