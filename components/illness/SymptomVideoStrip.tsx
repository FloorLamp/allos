"use client";

import VideoClipGrid, {
  type VideoClipView,
} from "@/components/video/VideoClipGrid";
import {
  uploadSymptomVideoAction,
  deleteSymptomVideoAction,
  updateSymptomVideoCaptionAction,
} from "@/app/(app)/medical/episodes/actions";

// The dated symptom-VIDEO strip on the episode page (#1224 phase 1) — the video
// sibling of SymptomPhotoStrip. Camera-first on mobile (the file input carries
// `accept="video/*,audio/*" capture`, so a phone opens the camera/mic). Each clip
// streams from the session-scoped Range serve route (/api/symptom-video/[id]);
// nothing here is on the share/print/export surface (the strictest-tier PHI
// default-exclude). A clip with embedded location metadata shows the privacy note.

export interface SymptomVideoView {
  id: number;
  date: string;
  symptom: string | null;
  caption: string | null;
  kind: string;
  hasLocation: boolean;
  durationSec: number | null;
}

export default function SymptomVideoStrip({
  videos,
  uploadDate,
  canWrite,
  profileId,
}: {
  videos: SymptomVideoView[];
  uploadDate: string;
  canWrite: boolean;
  // The cross-profile write target (#879) — set on a household member's episode
  // page so each write gates on THAT profile (requireProfileWriteAccess). Absent on
  // the acting profile's own page.
  profileId?: number;
}) {
  const clips: VideoClipView[] = videos.map((v) => ({
    id: v.id,
    label: v.date,
    caption: v.caption,
    kind: v.kind,
    hasLocation: v.hasLocation,
    durationSec: v.durationSec,
  }));

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        Video clips
      </h3>
      <VideoClipGrid
        clips={clips}
        serveBase="/api/symptom-video"
        canWrite={canWrite}
        testid="symptom-video-strip"
        emptyText="No clips yet. Add one to capture a symptom in motion — a tremor, tic, seizure, gait episode, or a cough/breathing sound."
        addLabel="Add clip"
        onUpload={async (file, poster, caption) => {
          const fd = new FormData();
          fd.set("video", file);
          if (poster)
            fd.set(
              "poster",
              new File([poster], "poster.jpg", { type: "image/jpeg" })
            );
          fd.set("date", uploadDate);
          if (caption) fd.set("caption", caption);
          if (profileId != null) fd.set("profileId", String(profileId));
          return uploadSymptomVideoAction(fd);
        }}
        onDelete={async (id) => {
          const fd = new FormData();
          fd.set("videoId", String(id));
          if (profileId != null) fd.set("profileId", String(profileId));
          return deleteSymptomVideoAction(fd);
        }}
        onEditCaption={async (id, caption) => {
          const fd = new FormData();
          fd.set("videoId", String(id));
          fd.set("caption", caption);
          if (profileId != null) fd.set("profileId", String(profileId));
          return updateSymptomVideoCaptionAction(fd);
        }}
      />
    </div>
  );
}
