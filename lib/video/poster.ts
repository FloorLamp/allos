// Process an optional client-extracted frame through the shared photo pipeline.
// Invalid or missing posters become null without blocking the clip upload.
// Only the poster is cleaned here; the video container is stored unchanged.
// See docs/internals/photo-core.md and docs/internals/video-core.md.

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
