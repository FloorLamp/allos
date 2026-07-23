// SERVER ingest of the shared video core (#1224): one ingestVideo() every video
// domain's write core calls, so the sniff + cap + hash treatment can never
// diverge per domain (the #1119 processPhoto chokepoint, applied to clip bytes).
// Order is load-bearing:
//
//   1. gate: empty / oversized (byte cap) — cheap rejects before parsing;
//   2. SNIFF the container by magic (never the client-declared type) → server-
//      trusted MIME, kind (video/audio), duration, container creation-time, and
//      whether a LOCATION atom is present (lib/video-sniff.ts, pure);
//   3. enforce the 60s cap against the sniffed duration (no ffmpeg);
//   4. content hash of the ORIGINAL bytes (identical uploads dedup identically).
//
// Unlike the photo pipeline there is DELIBERATELY no re-encode/strip: the clip is
// stored AS-IS (the no-native-dependency line). Location metadata is DETECTED to
// drive a visible privacy note (never decoded, never stored as a coordinate); the
// phase-2 in-app MediaRecorder path is metadata-clean by construction. This module
// is DB-free and PURE-ish (only crypto + the pure sniffer), but its callers own
// the DB, so its end-to-end coverage lives in the DB/action tiers.

import crypto from "node:crypto";
import { sniffVideo, type VideoKind } from "../video-sniff";
import { checkVideoCaps, MAX_VIDEO_BYTES } from "./policy";

// A validated, storage-ready clip. `bytes` are the ORIGINAL upload (unmodified);
// `mime`/`kind`/`durationSec` are SERVER-derived from the bytes; `creationDate`
// is the harvested container date (or null); `hasLocation` drives the privacy
// note; `contentHash` is the sha256 of the original bytes.
export interface IngestedVideo {
  bytes: Buffer;
  mime: string;
  kind: VideoKind;
  durationSec: number | null;
  sizeBytes: number;
  contentHash: string;
  creationDate: string | null;
  hasLocation: boolean;
}

export type IngestVideoOutcome =
  | { kind: "ingested"; video: IngestedVideo }
  | { kind: "invalid"; error: string };

export function ingestVideo(input: Buffer): IngestVideoOutcome {
  if (input.length === 0) return { kind: "invalid", error: "Empty file." };
  if (input.length > MAX_VIDEO_BYTES)
    return {
      kind: "invalid",
      error: "That clip is too large (max 100 MB).",
    };

  const sniff = sniffVideo(input);
  if (!sniff)
    return {
      kind: "invalid",
      error: "That file isn't a supported video or audio clip.",
    };

  const caps = checkVideoCaps(input.length, sniff.durationSec);
  if (!caps.ok) return { kind: "invalid", error: caps.error! };

  return {
    kind: "ingested",
    video: {
      bytes: input,
      mime: sniff.mime,
      kind: sniff.kind,
      durationSec: sniff.durationSec,
      sizeBytes: input.length,
      contentHash: crypto.createHash("sha256").update(input).digest("hex"),
      creationDate: sniff.creationDate,
      hasLocation: sniff.hasLocation,
    },
  };
}
