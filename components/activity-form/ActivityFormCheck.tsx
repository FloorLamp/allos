"use client";

import { useCallback, useEffect, useState } from "react";
import ActivityVideoStrip, {
  type ActivityVideoView,
} from "@/components/activity/ActivityVideoStrip";
import { listActivityVideosAction } from "@/app/(app)/journal/video-actions";

// The activity editor's "Form check" block (#1457) — the ADD entry point for
// training clips, and the reason the Journal card's strip could stop rendering an
// empty state on every writable activity.
//
// Why HERE: attaching a clip is an act of editing the activity, so it belongs with
// the activity's other fields rather than shouting from a read surface. Burying it
// in the card's ⋯ overflow menu was considered and rejected (discoverability), as
// was gating it by activity type — a clip on a run is unusual but legitimate.
//
// EDIT MODE ONLY, and that is a data constraint rather than a preference:
// `activity_videos` rows need an `activityId`, which the editor's create mode does
// not have until the row is saved. During first-time logging the block therefore
// appears once the activity is saved and reopened. Deferred upload (hold the file
// client-side until save, then upload) was weighed and rejected — it buys a
// marginal flow at the cost of a client-held-blob lifecycle (navigation loss, size
// limits, retry semantics). In-session capture, if ever wanted, rides the live
// editor's own id timing (#924), not this.
//
// It owns its own fetch: the editor is a client component opened from several entry
// points (Journal card, repeat, live resume), so unlike the Journal card — which is
// handed clips by the feed — there is no server component above it holding them.
export default function ActivityFormCheck({
  activityId,
}: {
  activityId: number;
}) {
  const [videos, setVideos] = useState<ActivityVideoView[] | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    void listActivityVideosAction(activityId).then((r) => {
      if (!cancelled) setVideos(r.ok ? r.videos : []);
    });
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  // Re-reads on activity change. The grid's own `router.refresh()` repaints the
  // server tree behind the editor; this component's state is client-side and
  // outlives it, so an upload/delete calls `onChange` to re-read here too.
  useEffect(() => load(), [load]);

  // Until the first read lands, render nothing rather than an empty-state flash
  // that would claim "no clips" about an activity that may well have some.
  if (videos == null) return null;

  return (
    <section data-testid="activity-form-check">
      <ActivityVideoStrip
        activityId={activityId}
        videos={videos}
        // The editor is reachable only with write access (the card gates
        // `openEdit` on it) and every action re-checks server-side.
        canWrite
        showAdd
        onChange={load}
      />
    </section>
  );
}
