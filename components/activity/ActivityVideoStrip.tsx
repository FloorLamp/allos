"use client";

import VideoClipGrid, {
  type VideoClipView,
} from "@/components/video/VideoClipGrid";
import {
  uploadActivityVideoAction,
  deleteActivityVideoAction,
  updateActivityVideoCaptionAction,
} from "@/app/(app)/journal/video-actions";

// Per-activity form-check video strip on the Journal card (#1224 phase 1). Attach
// a lift/movement clip to an activity for later form review; each clip streams from
// the session-scoped Range serve route (/api/activity-video/[id]). Active-profile
// scoped (the Journal is the acting profile's training surface). A clip carrying
// embedded location metadata shows the privacy note.

export interface ActivityVideoView {
  id: number;
  exercise: string | null;
  caption: string | null;
  kind: string;
  hasLocation: boolean;
  durationSec: number | null;
}

export default function ActivityVideoStrip({
  activityId,
  videos,
  canWrite,
}: {
  activityId: number;
  videos: ActivityVideoView[];
  canWrite: boolean;
}) {
  // Nothing to show and no write access → render nothing (keeps a read-only card
  // for another profile clean).
  if (videos.length === 0 && !canWrite) return null;

  const clips: VideoClipView[] = videos.map((v) => ({
    id: v.id,
    label: v.exercise ?? "Form check",
    caption: v.caption,
    kind: v.kind,
    hasLocation: v.hasLocation,
    durationSec: v.durationSec,
  }));

  return (
    <div className="mt-3 border-t border-black/5 pt-3 dark:border-white/10">
      <h4 className="section-label mb-2">Form check</h4>
      <VideoClipGrid
        clips={clips}
        serveBase="/api/activity-video"
        canWrite={canWrite}
        testid={`activity-video-strip-${activityId}`}
        emptyText="No clips. Add one to review your form on this session."
        addLabel="Add form clip"
        onUpload={async (file, poster, caption) => {
          const fd = new FormData();
          fd.set("activityId", String(activityId));
          fd.set("video", file);
          if (poster)
            fd.set(
              "poster",
              new File([poster], "poster.jpg", { type: "image/jpeg" })
            );
          if (caption) fd.set("caption", caption);
          return uploadActivityVideoAction(fd);
        }}
        onDelete={async (id) => {
          const fd = new FormData();
          fd.set("videoId", String(id));
          return deleteActivityVideoAction(fd);
        }}
        onEditCaption={async (id, caption) => {
          const fd = new FormData();
          fd.set("videoId", String(id));
          fd.set("caption", caption);
          return updateActivityVideoCaptionAction(fd);
        }}
      />
    </div>
  );
}
