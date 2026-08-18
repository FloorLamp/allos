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
// activity; each clip streams from the session-scoped
// Range serve route (/api/activity-video/[id]). Active-profile scoped (the Training Log
// is the acting profile's training surface). A clip carrying embedded location
// metadata shows the privacy note.
//
// TWO placements since #1457, distinguished by `showAdd`:
//
//   - The Training Log CARD (`showAdd` omitted) is a READ surface: it renders only when
//     clips exist. It used to render for every writable activity regardless of type
//     or content, so a Strava easy run, a walk, and an imported swim each carried a
//     "Media" heading, an empty-state line, and a button — the affordance was
//     loudest exactly where it was useless, and it cost that vertical space on
//     EVERY card (the #1416/#1455 mobile-density concern). Per-clip caption edit and
//     delete stay (`canWrite` still gates those) — only the ADD entry point moved.
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
  onChange,
}: {
  activityId: number;
  media: ActivityMediaView[];
  canWrite: boolean;
  // Render the add affordance (and therefore the empty state). The editor sets it;
  // the Training Log card does not.
  showAdd?: boolean;
  // A page-level Details card already owns its surface and heading.
  compact?: boolean;
  // Notifies the editor that the clip set changed, so it can re-read it — the card
  // gets the same news from the clip actions' own revalidate.
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
          const r = await deleteActivityVideoAction(fd);
          if (r.ok) onChange?.();
          return r;
        }}
        onEditCaption={async (id, caption) => {
          const fd = new FormData();
          fd.set("videoId", String(id));
          fd.set("caption", caption);
          const r = await updateActivityVideoCaptionAction(fd);
          if (r.ok) onChange?.();
          return r;
        }}
      />
    </div>
  );
}
