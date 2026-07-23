// SERVER half of the shared photo core (#1119): one processPhoto() every photo
// domain's ingest calls, so the privacy/size treatment can never diverge per
// domain (the Telegram-chokepoint philosophy applied to photo bytes). Order is
// load-bearing:
//
//   1. gate: empty / oversized / not-an-image (magic-byte sniff — the stored mime
//      is SERVER-derived, never the client-declared type);
//   2. HARVEST the capture date out of EXIF *before* the strip (the one useful
//      truth; GPS is deliberately never harvested — see lib/photo/exif.ts);
//   3. auto-orient: bake the EXIF orientation into pixels;
//   4. downscale to PHOTO_MAX_EDGE + re-encode JPEG — a re-encode via sharp
//      carries NO metadata (no withMetadata()), so EXIF/GPS/XMP/ICC are gone;
//   5. VERIFY the strip (defense in depth — refuse to hand back bytes that still
//      carry an Exif segment);
//   6. thumbnail (PHOTO_THUMB_EDGE) + content hash of the PROCESSED bytes.
//
// The caller (a domain write core like lib/progress-photo-write.ts) owns the DB:
// per-profile content-hash dedup, the row insert, and the file store
// (lib/photo/store.ts). This module is DB-free but NOT pure (sharp is a native
// image codec), so its end-to-end tests live in the DB/action tiers; the pure
// tier covers the exif + policy halves.
//
// Native dependency note (#1119 PR): sharp/libvips — already shipped transitively
// via Next.js's image optimizer; now a direct dependency because this pipeline is
// correctness-critical (EXIF strip + auto-orient are non-negotiable).

import crypto from "node:crypto";
import sharp from "sharp";
import { sniffImageMime, MAX_PHOTO_BYTES } from "../symptom-photo-write";
import { readJpegExif, EMPTY_EXIF_SUMMARY } from "./exif";
import {
  PHOTO_MAX_EDGE,
  PHOTO_THUMB_EDGE,
  PHOTO_JPEG_QUALITY,
  PHOTO_THUMB_QUALITY,
} from "./policy";

// A processed, storage-ready photo. `bytes`/`thumbBytes` are always re-encoded
// JPEG with no metadata; `captureDate` is the EXIF date harvested before the
// strip (or null); `contentHash` is the sha256 of the PROCESSED bytes (identical
// captures dedup after identical processing).
export interface ProcessedPhoto {
  bytes: Buffer;
  thumbBytes: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
  sizeBytes: number;
  contentHash: string;
  captureDate: string | null;
}

export type ProcessPhotoOutcome =
  | { kind: "processed"; photo: ProcessedPhoto }
  | { kind: "invalid"; error: string };

export async function processPhoto(
  input: Buffer
): Promise<ProcessPhotoOutcome> {
  if (input.length === 0) return { kind: "invalid", error: "Empty file." };
  if (input.length > MAX_PHOTO_BYTES)
    return {
      kind: "invalid",
      error: "That image is too large (max 15 MB).",
    };
  const mime = sniffImageMime(input);
  if (!mime)
    return { kind: "invalid", error: "That file isn't a supported image." };
  if (mime === "image/heic")
    return {
      kind: "invalid",
      error:
        "HEIC photos aren't supported yet — use the in-app camera, or convert to JPEG first.",
    };

  // Harvest BEFORE the strip. JPEG only — that's the only input container we
  // read metadata from; everything else just gets stripped by the re-encode.
  const exif = mime === "image/jpeg" ? readJpegExif(input) : EMPTY_EXIF_SUMMARY;

  let bytes: Buffer;
  let width: number;
  let height: number;
  try {
    // .rotate() with no args bakes the EXIF orientation into pixels. No
    // withMetadata(): the output carries no EXIF/GPS/XMP/ICC.
    const out = await sharp(input)
      .rotate()
      .resize({
        width: PHOTO_MAX_EDGE,
        height: PHOTO_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: PHOTO_JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    bytes = out.data;
    width = out.info.width;
    height = out.info.height;
  } catch {
    return { kind: "invalid", error: "That image couldn't be read." };
  }

  // Defense in depth: never store bytes that still carry a metadata segment.
  const check = readJpegExif(bytes);
  if (check.hasExif || check.hasGps)
    return {
      kind: "invalid",
      error: "That image couldn't be cleaned of metadata.",
    };

  let thumbBytes: Buffer;
  try {
    thumbBytes = await sharp(bytes)
      .resize({
        width: PHOTO_THUMB_EDGE,
        height: PHOTO_THUMB_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: PHOTO_THUMB_QUALITY })
      .toBuffer();
  } catch {
    return { kind: "invalid", error: "That image couldn't be read." };
  }

  return {
    kind: "processed",
    photo: {
      bytes,
      thumbBytes,
      mime: "image/jpeg",
      width,
      height,
      sizeBytes: bytes.length,
      contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
      captureDate: exif.captureDate,
    },
  };
}
