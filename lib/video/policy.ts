// PURE caps + default-date policy for the shared video core (#1224) — the one
// place the clip size/length limits and the default-capture-date rule live,
// shared by the client picker and the server ingest (#221 one-question-one-
// computation). Unit-tested in lib/__tests__/video-policy.test.ts.

import { isRealIsoDate } from "../date";

// Per-clip byte ceiling (#1224 product decision: 100 MB). A 60s phone clip lands
// well under this; the byte cap is the always-on guard even for containers whose
// duration the sniffer can't measure (Ogg / MP3).
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// Per-clip length ceiling in seconds (#1224 product decision: 60s). Enforced only
// when the sniffer parsed a duration (mvhd / EBML); an unparseable-duration
// container passes the length gate and relies on the byte cap.
export const MAX_VIDEO_SECONDS = 60;

// A short grace so a clip a hair over 60s (a 60.4s phone capture) isn't rejected
// on a rounding boundary; anything meaningfully longer is refused.
export const VIDEO_SECONDS_GRACE = 1;

export interface VideoCapDecision {
  ok: boolean;
  error?: string;
}

// Decide whether a clip's measured size/duration are within the caps. Pure —
// takes the already-sniffed duration (null when unmeasurable).
export function checkVideoCaps(
  sizeBytes: number,
  durationSec: number | null
): VideoCapDecision {
  if (sizeBytes <= 0) return { ok: false, error: "Empty file." };
  if (sizeBytes > MAX_VIDEO_BYTES)
    return { ok: false, error: "That clip is too large (max 100 MB)." };
  if (
    durationSec != null &&
    durationSec > MAX_VIDEO_SECONDS + VIDEO_SECONDS_GRACE
  )
    return {
      ok: false,
      error: "That clip is too long (max 60 seconds). Trim it and try again.",
    };
  return { ok: true };
}

// The clip's default date (#1224): an explicit user-entered date always wins;
// else the container creation date the sniffer harvested (a clip recorded last
// Tuesday and uploaded today should default to Tuesday) — but never a FUTURE date
// (a camera with a wrong clock must not push the clip past "today"); else today.
// The photo core's resolvePhotoDate twin.
export function resolveVideoDate(
  explicitDate: string | null,
  containerDate: string | null,
  today: string
): string {
  if (explicitDate && isRealIsoDate(explicitDate)) return explicitDate;
  if (containerDate && isRealIsoDate(containerDate) && containerDate <= today)
    return containerDate;
  return today;
}
