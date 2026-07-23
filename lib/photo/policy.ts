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

// Upload byte cap shared by every photo-capture domain (#1284): a phone snapshot is
// well under this; anything larger is a mistake or abuse. This is the ONE place the
// ceiling lives so the domain ingests (lib/photo/ingest.ts, lib/symptom-photo-write.ts,
// lib/skin-photo-write.ts) can't drift — and it is DISTINCT from the profile-avatar cap
// (lib/profile-photo.ts MAX_AVATAR_BYTES, 5 MB), which is deliberately tighter.
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

// Image types accepted, keyed by the magic-byte sniff below. The stored mime is
// SERVER-derived (sniffed here), never the client-declared one, so a mislabeled file
// can't smuggle a non-image through (the medical-pipeline #27 posture). Pure byte
// inspection, so it belongs in this shared policy module alongside the size cap (#1284).
const IMAGE_SNIFFERS: { mime: string; test: (b: Buffer) => boolean }[] = [
  {
    mime: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/png",
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/gif",
    test: (b) =>
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: "image/webp",
    test: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
  {
    mime: "image/heic",
    test: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 4, 12).startsWith("ftyp") &&
      /hei[cf]|mif1|msf1/.test(b.toString("ascii", 8, 16)),
  },
];

// The server-derived image mime, or null when the bytes aren't a recognized image.
export function sniffImageMime(buffer: Buffer): string | null {
  for (const s of IMAGE_SNIFFERS) {
    if (s.test(buffer)) return s.mime;
  }
  return null;
}

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
