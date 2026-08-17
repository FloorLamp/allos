"use client";

import { useRouter } from "next/navigation";
import { IconPencil, IconArrowUpRight } from "@tabler/icons-react";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import TrainingLogCard from "../TrainingLogCard";
import type {
  TrainingLogCardData,
  TrainingLogCardSubject,
} from "@/lib/training-log-card";
import type { ActivityDetailSibling } from "@/lib/training-activity-detail";
import type { ProgressDelta } from "@/lib/progress-delta";
import type { UnitPrefs } from "@/lib/settings";
import { trainingActivityPageHref } from "@/lib/hrefs";

// The client host for the record card (#2870/#2897) — ONE component, three
// hosts. host="page" (default): the canonical activity page, whose edits use
// the same overlay at every viewport and for every activity type. host="pane": the
// Training Log's desktop reading pane AND the phone's expand-in-place row —
// same record markup, no dock of its own (edits dock into the log's general
// column or the overlay, exactly as a card edit does), and an "Open ↗" door
// promoting to the full page for everything this host doesn't carry (heart
// rate, the ledger walk).
//
// Multi-view (#1330): `subject`/`actingProfileId` pass through whole, so the
// card's own gating (view-only titles, subject chips, per-subject menus) is
// identical in every host. The drill-in handlers are HOST decisions: the log
// injects its in-aside stat panels (gated by the fitness rules); the page
// defaults exercise names to their Analyze deep link.
export default function ActivityRecord({
  card,
  siblings,
  units,
  canWrite,
  host = "page",
  partDeltas,
  subject,
  actingProfileId,
  onSelectExercise,
  onSelectCardio,
  onSelectSport,
  onFilterTag,
}: {
  card: TrainingLogCardData;
  siblings: ActivityDetailSibling[];
  units: UnitPrefs;
  canWrite: boolean;
  host?: "page" | "pane";
  // "vs last" per part (#2870), supplied by the PAGE host only — the pane builds
  // its card from feed data with no fetch (#2897), so it has none to give.
  partDeltas?: (ProgressDelta | null)[];
  subject?: TrainingLogCardSubject;
  actingProfileId?: number;
  onSelectExercise?: (name: string) => void;
  onSelectCardio?: (name: string) => void;
  onSelectSport?: (name: string) => void;
  onFilterTag?: (kind: "muscle" | "region", value: string) => void;
}) {
  const router = useRouter();
  const { openEdit } = useActivityEditor();

  // The page host's default exercise door: the lift's Analyze page. Pane hosts
  // inject their own handlers (or none, for gated subjects) — never this.
  const selectExercise =
    onSelectExercise ??
    (host === "page"
      ? (name: string) =>
          router.push(
            `/training?tab=analyze&kind=strength&item=${encodeURIComponent(name)}`
          )
      : undefined);

  return (
    <div>
      {/* h-9 matches the feed's first day-heading band, so the reading pane's
          card top aligns with the selected row's top. The page has real header
          actions and does not spend a blank row on this pane-only toolbar. */}
      {host === "pane" && (
        <div className="mb-2 flex h-9 items-center justify-end gap-3">
          {/* The pane's door to the record's own page (#2983). It carries an
              icon, so the spinner takes the icon's box: nothing shifts, and the
              label the reader is aiming at is untouched. */}
          <PendingLink
            href={trainingActivityPageHref(card.activity.id)}
            label="activity page"
            testId="activity-pane-open"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            {(pending) => (
              <>
                Open{" "}
                <PendingIconSlot
                  pending={pending}
                  size="h-4 w-4"
                  icon={<IconArrowUpRight className="h-4 w-4" aria-hidden />}
                />
              </>
            )}
          </PendingLink>
          {canWrite && (
            <button
              type="button"
              data-testid="activity-page-edit"
              onClick={() => openEdit(card.activity)}
              className="btn-ghost inline-flex items-center gap-1.5 text-sm"
            >
              <IconPencil className="h-4 w-4" aria-hidden /> Edit
            </button>
          )}
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
        // A detail page promotes the route into its own capability section;
        // feed/pane cards keep the compact thumbnail.
        routePolyline={host === "page" ? null : card.routePolyline}
        subject={subject}
        actingProfileId={actingProfileId}
        mergeSiblings={siblings}
        keeperLabel={card.provenance.label}
        foldValues={card.foldValues}
        units={units}
        videos={card.videos}
        canWrite={canWrite}
        detailView={host === "page"}
        // The pane's host row already owns the #activity-N anchor (#2897).
        withAnchor={host === "page"}
        partDeltas={partDeltas}
        onSelectExercise={selectExercise}
        onSelectCardio={onSelectCardio}
        onSelectSport={onSelectSport}
        onFilterTag={onFilterTag}
      />
    </div>
  );
}
