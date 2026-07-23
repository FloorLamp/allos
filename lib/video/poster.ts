// Poster-frame ingest for the video core (#1224). The client extracts a single
// frame from the picked clip to a canvas and submits it as a JPEG alongside the
// clip; this runs that poster through the #1119 photo pipeline (processPhoto —
// sniff, EXIF-strip, auto-orient, downscale) so the stored poster is metadata-
// clean exactly like every other stored image. Returns the stripped JPEG bytes,
// or null when there is no usable poster (an audio clip, or a browser that
// couldn't decode the frame — the grid then shows a placeholder). Never throws:
// a bad poster degrades to null, never blocking the clip upload.
//
// NOTE the poster passes through the SAME strip pipeline as physique/symptom
// photos — the one metadata chokepoint. The CLIP itself is stored as-is (no
// re-encode) by design; only its poster image is scrubbed.

import { processPhoto } from "../photo/ingest";

export async function posterBytesFrom(value: unknown): Promise<Buffer | null> {
  if (!(value instanceof File) || value.size === 0) return null;
  try {
    const processed = await processPhoto(
      Buffer.from(await value.arrayBuffer())
    );
    return processed.kind === "processed" ? processed.photo.bytes : null;
  } catch {
    return null;
  }
}
