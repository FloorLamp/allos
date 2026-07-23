// PURE sizing/date policy for the shared photo core (#1119) — the one place the
// downscale/thumbnail geometry and the default-date rule live, shared by BOTH
// halves of the pipeline (#221 one-question-one-computation):
//   - the CLIENT capture path (components/photo/PhotoCapture + client-compress)
//     sizes its canvas with fitWithin, so a captured/queued blob is already small;
//   - the SERVER ingest (lib/photo/ingest.ts) resizes to the same box and its
//     tests assert the stored dimensions equal fitWithin's answer.
// Unit-tested in lib/__tests__/photo-policy.test.ts.

import { isRealIsoDate } from "../date";

// Max long edge of a stored photo, px. Physique/lesion comparison never needs
// more, and it bounds storage/bandwidth (a 12 MP upload becomes ~300 KB).
export const PHOTO_MAX_EDGE = 2048;

// Long edge of the grid/strip thumbnail, px.
export const PHOTO_THUMB_EDGE = 320;

// Re-encode quality for stored photos / thumbnails (JPEG).
export const PHOTO_JPEG_QUALITY = 82;
export const PHOTO_THUMB_QUALITY = 78;

// Client-side canvas re-encode quality (0-1 for canvas.toBlob).
export const PHOTO_CLIENT_QUALITY = 0.85;

// Fit width×height inside a maxEdge box, preserving aspect ratio, never
// enlarging. Dimensions are rounded and floored at 1px.
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number; scaled: boolean } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h, scaled: false };
  const f = maxEdge / long;
  return {
    width: Math.max(1, Math.round(w * f)),
    height: Math.max(1, Math.round(h * f)),
    scaled: true,
  };
}

// The photo's default date (#1119): an explicit user-entered date always wins;
// else the EXIF capture date harvested before the strip (a photo taken last
// Tuesday and uploaded today should not default to today) — but never a FUTURE
// date (a camera with a wrong clock must not push the photo past "today");
// else today.
export function resolvePhotoDate(
  explicitDate: string | null,
  exifCaptureDate: string | null,
  today: string
): string {
  if (explicitDate && isRealIsoDate(explicitDate)) return explicitDate;
  if (
    exifCaptureDate &&
    isRealIsoDate(exifCaptureDate) &&
    exifCaptureDate <= today
  )
    return exifCaptureDate;
  return today;
}
