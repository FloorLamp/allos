"use client";

import { useCallback, useEffect, useState } from "react";
import ActivityMediaStrip, {
  type ActivityMediaView,
} from "@/components/activity/ActivityMediaStrip";
import { listActivityMediaAction } from "@/app/(app)/training/video-actions";

// The activity editor's media block (#1457) — the ADD entry point for attached
// clips, and the reason read surfaces do not need to carry an add affordance.
//
// Why HERE: attaching a clip is an act of editing the activity, so it belongs with
// the activity's other fields rather than shouting from a read surface. Burying it
// in the card's ⋯ overflow menu was considered and rejected (discoverability), as
// was gating it by activity type — a clip on a run is unusual but legitimate.
//
// It needs a SAVED ACTIVITY ID, and that is a data constraint rather than a
// preference: `activity_videos` rows need an `activityId`. It is NOT "edit mode
// only" — the caller passes `editData?.id ?? createdId`, so during first-time
// logging the block appears the moment autosave inserts the row, with no save-and-
// reopen round trip (#1520; it used to gate on `editData`, which never fills in on a
// create-mode form, so the block simply never showed while logging). Deferred upload
// (hold the file client-side until save, then upload) was weighed and rejected — it
// buys a marginal flow at the cost of a client-held-blob lifecycle (navigation loss,
// size limits, retry semantics), and it is still rejected: before the row exists
// there is no block at all. In-session capture, if ever wanted, rides the live
// editor's own id timing (#924), not this.
//
// It owns its own fetch: the editor is a client component opened from several entry
// points (Training Log, repeat, live resume), so unlike the activity detail page —
// which is handed clips by its server loader — there is no server component above
// it holding them.
export default function ActivityFormMedia({
  activityId,
  subjectProfileId,
  className = "",
  onCountChange,
}: {
  activityId: number;
  subjectProfileId?: number;
  className?: string;
  onCountChange?: (count: number) => void;
}) {
  const [media, setMedia] = useState<ActivityMediaView[] | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    void listActivityMediaAction(activityId, subjectProfileId).then((r) => {
      if (cancelled) return;
      const next = r.ok ? r.media : [];
      setMedia(next);
      onCountChange?.(next.length);
    });
    return () => {
      cancelled = true;
    };
  }, [activityId, onCountChange, subjectProfileId]);

  // Re-reads on activity change. The clip actions' own revalidate repaints the
  // server tree behind the editor; this component's state is client-side and
  // outlives it, so an upload/delete calls `onChange` to re-read here too.
  useEffect(() => load(), [load]);

  // Until the first read lands, render nothing rather than an empty-state flash
  // that would claim "no clips" about an activity that may well have some.
  if (media == null) return null;

  return (
    <section data-testid="activity-form-media" className={className}>
      <ActivityMediaStrip
        activityId={activityId}
        media={media}
        // The editor is reachable only with write access (the card gates
        // `openEdit` on it) and every action re-checks server-side.
        canWrite
        showAdd
        subjectProfileId={subjectProfileId}
        onChange={load}
      />
    </section>
  );
}
