// CLIENT half of the photo core's compression/EXIF posture (#1119): re-encode a
// picked/captured image through a canvas before upload. A canvas re-encode
// carries NO EXIF — so even the native file-input fallback uploads a clean,
// small JPEG when the browser can decode it. The server pipeline
// (lib/photo/ingest.ts) strips and downscales REGARDLESS — never trust the
// client; this just makes the common path small (an offline-queued or slow-link
// upload is ~200-400 KB, not 12 MP) and clean at the first hop.
//
// Browser-only (canvas/createImageBitmap): no test coverage here — the sizing
// decision it applies is the pure fitWithin (lib/photo/policy.ts), which is.

import { fitWithin, PHOTO_MAX_EDGE, PHOTO_CLIENT_QUALITY } from "./policy";

// Re-encode to a downscaled JPEG blob. Falls back to the ORIGINAL blob when the
// browser can't decode it (e.g. HEIC outside Safari) — the server then gates it.
export async function compressImageBlob(
  input: Blob,
  maxEdge: number = PHOTO_MAX_EDGE,
  quality: number = PHOTO_CLIENT_QUALITY
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(input);
    try {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return input;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality)
      );
      return blob ?? input;
    } finally {
      bitmap.close();
    }
  } catch {
    return input;
  }
}
