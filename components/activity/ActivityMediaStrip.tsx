"use client";

import VideoClipGrid, {
  type VideoClipView,
} from "@/components/video/VideoClipGrid";
import {
  uploadActivityVideoAction,
  deleteActivityVideoAction,
  updateActivityVideoCaptionAction,
} from "@/app/(app)/training/video-actions";

// Per-activity media strip (#1224 phase 1). Attach a video or audio clip to an
// activity; each clip streams from the session-scoped Range serve route
// (/api/activity-video/[id]). The route gates the clip's owning profile, which
// also supports detail pages opened from household multi-view. A clip carrying
// embedded location metadata shows the privacy note.
//
// TWO placements since #1457, distinguished by `showAdd`:
//
//   - The activity DETAIL page (`showAdd` omitted) is the READ surface and renders
//     only when clips exist. Compact Training Log rows carry no media grid. Per-clip
//     caption edit and delete remain gated by `canWrite`; only the ADD entry point
//     belongs in the editor.
//   - The activity EDITOR (`showAdd`) is the WRITE surface: it always renders, empty
//     state included, because that is now where a clip gets attached.
//
// No type gate in either place (owner call): a clip on a run is unusual but
// legitimate, and a heuristic here would be one more thing to maintain.

export interface ActivityMediaView {
  id: number;
  exercise: string | null;
  caption: string | null;
  kind: string;
  hasLocation: boolean;
  durationSec: number | null;
}

export default function ActivityMediaStrip({
  activityId,
  media,
  canWrite,
  showAdd = false,
  compact = false,
  subjectProfileId,
  onChange,
}: {
  activityId: number;
  media: ActivityMediaView[];
  canWrite: boolean;
  // Render the add affordance (and therefore the empty state). The editor sets it;
  // the activity detail page does not.
  showAdd?: boolean;
  // A page-level Details card already owns its surface and heading.
  compact?: boolean;
  // Multi-view detail/editor surfaces keep the acting profile unchanged, so
  // writes carry the media owner's profile explicitly.
  subjectProfileId?: number;
  // Notifies the editor that the clip set changed, so it can re-read it — the detail
  // page gets the same news from the clip actions' own revalidate.
  onChange?: () => void;
}) {
  // Without the add affordance this is a pure read surface, so an empty one has
  // nothing to say — render nothing rather than an empty "Media" block.
  if (media.length === 0 && !showAdd) return null;

  const clips: VideoClipView[] = media.map((item) => ({
    id: item.id,
    label: item.exercise ?? "Activity media",
    caption: item.caption,
    kind: item.kind,
    hasLocation: item.hasLocation,
    durationSec: item.durationSec,
  }));

  return (
    <div
      className={
        compact
          ? "mt-4"
          : "mt-3 border-t border-black/5 pt-3 dark:border-white/10"
      }
    >
      {!compact && <h4 className="section-label mb-2">Media</h4>}
      <VideoClipGrid
        clips={clips}
        serveBase="/api/activity-video"
        canWrite={canWrite}
        showAdd={showAdd}
        testid={`activity-media-strip-${activityId}`}
        emptyText="No media attached yet. Add a video or audio clip."
        addLabel="Add media"
        onUpload={async (file, poster, caption) => {
          const fd = new FormData();
          fd.set("activityId", String(activityId));
          if (subjectProfileId != null)
            fd.set("profile_id", String(subjectProfileId));
          fd.set("video", file);
          if (poster)
            fd.set(
              "poster",
              new File([poster], "poster.jpg", { type: "image/jpeg" })
            );
          if (caption) fd.set("caption", caption);
          const r = await uploadActivityVideoAction(fd);
          if (r.ok) onChange?.();
          return r;
        }}
        onDelete={async (id) => {
          const fd = new FormData();
          fd.set("videoId", String(id));
          if (subjectProfileId != null)
            fd.set("profile_id", String(subjectProfileId));
          const r = await deleteActivityVideoAction(fd);
          if (r.ok) onChange?.();
          return r;
        }}
        onEditCaption={async (id, caption) => {
          const fd = new FormData();
          fd.set("videoId", String(id));
          fd.set("caption", caption);
          if (subjectProfileId != null)
            fd.set("profile_id", String(subjectProfileId));
          const r = await updateActivityVideoCaptionAction(fd);
          if (r.ok) onChange?.();
          return r;
        }}
      />
    </div>
  );
}
