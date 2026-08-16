"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconPencil,
  IconArrowUpRight,
  IconArrowsShuffle,
} from "@tabler/icons-react";
import PendingLink, { PendingIconSlot } from "@/components/PendingLink";
import {
  useActivityEditor,
  useEditorDock,
} from "@/components/ActivityEditorProvider";
import TrainingLogCard from "../TrainingLogCard";
import type {
  TrainingLogCardData,
  TrainingLogCardSubject,
} from "@/lib/training-log-card";
import type { ActivityDetailSibling } from "@/lib/training-activity-detail";
import type { ProgressDelta } from "@/lib/progress-delta";
import type { UnitPrefs } from "@/lib/settings";
import { trainingActivityPageHref } from "@/lib/hrefs";

// The dock is worth a second column's width. Below this the provider's overlay
// is the better editor host (same fallback the Training Log uses at its own
// breakpoint) — the page column at phone width can't hold the form usably.
const ACTIVITY_PAGE_DOCK_QUERY = "(min-width: 768px)";

// The full page's editor dock, split out so the PANE host can omit it: the
// provider holds exactly ONE dock, and the Training Log's aside already
// registers the general column — a second, scoped registration from inside
// that very column would fight it (last-write-wins, and the loser's unregister
// closes whatever the winner hosts).
function PageDock({ activityId }: { activityId: number }) {
  // Scoped to THIS record's id: the page dock hosts only its own activity's
  // edits — a global "New activity" or a live resume stays in the overlay
  // instead of portaling an unrelated form under this record (the hook and the
  // provider's registerDock own the shared registration discipline).
  const { dockRef } = useEditorDock(ACTIVITY_PAGE_DOCK_QUERY, activityId);
  return (
    <div ref={dockRef} data-testid="activity-page-dock" className="mt-4" />
  );
}

// The client host for the record card (#2870/#2897) — ONE component, three
// hosts. host="page" (default): the canonical activity page; registers the
// scoped editor dock so "Edit" opens the full ActivityForm in place, bringing
// the autosave machinery and its edit-lock banner along. host="pane": the
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
  overlapping = [],
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
  // Same-day siblings that overlap this one on the clock (#2870). Supplied by the
  // PAGE host: in the log the twin is the row above, and the pane has that list
  // beside it — a page is where the adjacency, and with it the discovery, is lost.
  overlapping?: ActivityDetailSibling[];
  subject?: TrainingLogCardSubject;
  actingProfileId?: number;
  onSelectExercise?: (name: string) => void;
  onSelectCardio?: (name: string) => void;
  onSelectSport?: (name: string) => void;
  onFilterTag?: (kind: "muscle" | "region", value: string) => void;
}) {
  const router = useRouter();
  const { openEdit } = useActivityEditor();
  // Bumping this asks the card's own menu to open its merge picker.
  const [mergeSignal, setMergeSignal] = useState(0);

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
      {/* h-9 matches the feed's first day-heading band, so in the reading pane
          (whose host suppresses its spacer) this row occupies the heading's
          slot and the card top aligns with the selected row's top. */}
      <div className="mb-2 flex h-9 items-center justify-end gap-3">
        {host === "pane" && (
          // The pane's door to the record's own page (#2983). It carries an
          // icon, so the spinner takes the icon's box: nothing shifts, and the
          // label the reader is aiming at is untouched.
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
        )}
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
      {overlapping.length > 0 && canWrite && (
        <div
          data-testid="activity-overlap-banner"
          className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>
            {overlapping.length === 1 ? (
              <>
                <span className="font-medium">
                  {overlapping[0].sourceLabel}
                </span>{" "}
                also logged{" "}
                <span className="font-medium">{overlapping[0].title}</span> over
                the same clock time. The same session twice?
              </>
            ) : (
              <>
                {overlapping.length} other sessions cover the same clock time.
                One session logged more than once?
              </>
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            {overlapping.map((sib) => (
              <Link
                key={sib.id}
                href={trainingActivityPageHref(sib.id)}
                data-testid={`activity-overlap-compare-${sib.id}`}
                className="font-medium underline underline-offset-2"
              >
                Compare {sib.title}
              </Link>
            ))}
            <button
              type="button"
              data-testid="activity-overlap-merge"
              onClick={() => setMergeSignal((n) => n + 1)}
              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              <IconArrowsShuffle className="h-4 w-4" aria-hidden /> Merge…
            </button>
          </div>
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
        subject={subject}
        actingProfileId={actingProfileId}
        mergeSiblings={siblings}
        keeperLabel={card.provenance.label}
        foldValues={card.foldValues}
        units={units}
        videos={card.videos}
        canWrite={canWrite}
        // The pane's host row already owns the #activity-N anchor (#2897).
        withAnchor={host === "page"}
        partDeltas={partDeltas}
        openMergeSignal={mergeSignal}
        onSelectExercise={selectExercise}
        onSelectCardio={onSelectCardio}
        onSelectSport={onSelectSport}
        onFilterTag={onFilterTag}
      />
      {host === "page" && <PageDock activityId={card.activity.id} />}
    </div>
  );
}
