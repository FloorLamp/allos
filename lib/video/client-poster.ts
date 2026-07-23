// CLIENT half of the video core's poster-frame extraction (#1224): draw a single
// frame of a picked clip to a canvas and hand back a JPEG blob, so a grid can show
// a still without the browser (or the app) ever loading the whole clip. Submitted
// alongside the clip; the SERVER runs it through the #1119 photo strip pipeline
// (lib/video/poster.ts) so the stored poster is metadata-clean regardless.
//
// Best-effort by construction: an audio clip, a codec the browser can't decode
// (CI's headless Chromium on a synthetic fixture), or a slow decode all resolve to
// null — the upload proceeds posterless and the grid shows a placeholder. Never
// throws. Browser-only (a <video> element + canvas); no unit coverage here.

// Long edge of the extracted poster JPEG, px — enough for a grid thumbnail and a
// <video> poster attribute without bloating the upload.
const POSTER_MAX_EDGE = 640;
const POSTER_QUALITY = 0.8;
// Give a slow/large clip a bounded window to produce a frame, then give up.
const POSTER_TIMEOUT_MS = 6000;

export async function extractPosterFrame(file: File): Promise<Blob | null> {
  // Audio has no frame to draw.
  if (file.type.startsWith("audio/")) return null;

  return new Promise<Blob | null>((resolve) => {
    let settled = false;
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), POSTER_TIMEOUT_MS);

    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;

    video.onloadeddata = () => {
      // Seek a hair past the start (a keyframe near t=0) to avoid a black frame.
      try {
        const target = Number.isFinite(video.duration)
          ? Math.min(0.1, video.duration / 2)
          : 0.1;
        video.currentTime = target;
      } catch {
        finish(null);
      }
    };

    video.onseeked = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return finish(null);
      const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return finish(null);
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => finish(b), "image/jpeg", POSTER_QUALITY);
      } catch {
        finish(null);
      }
    };

    video.onerror = () => finish(null);
    video.src = url;
  });
}
