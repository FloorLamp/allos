// PURE magic-byte + container sniffing for uploaded VIDEO / AUDIO clips (issue
// #1224 — the upload-first sibling of the #1119 photo core). No DB / network /
// ffmpeg — this module is unit-tested over synthetic Buffer fixtures
// (lib/__tests__/video-sniff.test.ts, built by lib/video/fixture.ts).
//
// file-sniff.ts deliberately sniffs MP4/MOV/WebM containers to `null` (they are
// not supported IMAGE uploads). This module is the counterpart that DOES
// recognize them, so the video domains get a SERVER-trusted container MIME (never
// the client-declared type), the clip's duration (to enforce the 60s cap
// server-side — no ffmpeg), its container creation-time (the default capture
// date — the #1119 harvest-then-note twin), and whether it carries embedded
// LOCATION metadata (to drive the privacy warning). GPS is DETECTED for the flag
// but never DECODED into a coordinate — no field of the result can carry a
// location, mirroring the photo core's GPS posture (lib/photo/exif.ts).
//
// All of it is byte-level container parsing: an ISO-BMFF box walker (MP4/MOV/M4A)
// and a minimal EBML walker (WebM/Matroska), plus coarse magic for Ogg/MP3. It
// never trusts declared lengths blindly — every walk is bounded by the buffer end
// and a step guard, so a malformed clip returns a partial/`null` result rather
// than looping.

export type VideoContainer = "mp4" | "quicktime" | "webm" | "ogg" | "mp3";
export type VideoKind = "video" | "audio";

export interface VideoSniff {
  // Server-trusted container MIME (video/mp4, video/quicktime, video/webm,
  // audio/mp4, audio/webm, audio/ogg, audio/mpeg).
  mime: string;
  container: VideoContainer;
  // Whether the clip carries a video track. The audio-only variant (#1224 — cough
  // / breathing sounds) is `audio`; everything with a picture track is `video`.
  kind: VideoKind;
  // Clip length in whole+fractional seconds parsed from the container header
  // (mvhd for ISO-BMFF, Info/Duration for EBML), or null when the container can't
  // be measured cheaply (Ogg / MP3). The 60s cap is enforced only when non-null;
  // the byte cap always applies.
  durationSec: number | null;
  // The container's creation time as an ISO date (YYYY-MM-DD), or null. Used as the
  // clip's DEFAULT capture date (an explicit user date always wins). Never a FUTURE
  // date is invented here — the caller's resolveVideoDate clamps that.
  creationDate: string | null;
  // True when an embedded location/GPS atom is present (QuickTime `©xyz` or the
  // `com.apple.quicktime.location.ISO6709` metadata key). Drives the visible
  // privacy note. The COORDINATE is never read — only its presence.
  hasLocation: boolean;
}

// Seconds between the QuickTime/ISO-BMFF epoch (1904-01-01) and the Unix epoch
// (1970-01-01). mvhd creation_time counts from 1904.
const MAC_EPOCH_OFFSET = 2082844800;

// ── low-level byte helpers ──────────────────────────────────────────────────

function u32(buf: Buffer, off: number): number {
  return buf.readUInt32BE(off);
}

// A 64-bit big-endian read as a JS number. Safe for our domain (durations,
// creation times, box sizes on a ≤100 MB upload stay well under 2^53).
function u64(buf: Buffer, off: number): number {
  return u32(buf, off) * 0x100000000 + u32(buf, off + 4);
}

function asciiAt(buf: Buffer, off: number, len: number): string {
  return buf.length >= off + len ? buf.toString("latin1", off, off + len) : "";
}

function bytesAt(buf: Buffer, off: number, seq: number[]): boolean {
  if (buf.length < off + seq.length) return false;
  for (let i = 0; i < seq.length; i++)
    if (buf[off + i] !== seq[i]) return false;
  return true;
}

// Convert an ISO-BMFF creation_time (seconds since 1904) to a YYYY-MM-DD date, or
// null when it is zero / pre-Unix-epoch (an unset or nonsensical clock).
function macTimeToDate(seconds: number): string | null {
  if (!seconds || seconds <= MAC_EPOCH_OFFSET) return null;
  const ms = (seconds - MAC_EPOCH_OFFSET) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ── ISO-BMFF (MP4 / MOV / M4A) ──────────────────────────────────────────────

interface Box {
  type: string;
  // Absolute payload start (after the box header).
  start: number;
  // Absolute payload end (exclusive).
  end: number;
}

// Iterate the boxes that live in [start, end), calling `cb` for each. Bounded by
// the buffer and a strictly-increasing cursor so a zero/huge/overflowing size can
// never loop or read past the buffer.
function walkBoxes(
  buf: Buffer,
  start: number,
  end: number,
  cb: (box: Box) => void
): void {
  let pos = start;
  const limit = Math.min(end, buf.length);
  while (pos + 8 <= limit) {
    let size = u32(buf, pos);
    const type = asciiAt(buf, pos + 4, 4);
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > limit) break;
      size = u64(buf, pos + 8);
      headerLen = 16;
    } else if (size === 0) {
      // Extends to the end of the enclosing box.
      size = limit - pos;
    }
    if (size < headerLen) break; // malformed — stop rather than spin
    const payloadStart = pos + headerLen;
    const payloadEnd = Math.min(pos + size, limit);
    cb({ type, start: payloadStart, end: payloadEnd });
    if (pos + size <= pos) break; // overflow / non-progress guard
    pos += size;
  }
}

// Parse the mvhd box payload → { durationSec, creationDate }.
function parseMvhd(
  buf: Buffer,
  start: number,
  end: number
): { durationSec: number | null; creationDate: string | null } {
  if (start + 4 > end) return { durationSec: null, creationDate: null };
  const version = buf[start];
  let off = start + 4; // version(1) + flags(3)
  let creation: number;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (off + 28 > end) return { durationSec: null, creationDate: null };
    creation = u64(buf, off);
    off += 8; // creation_time
    off += 8; // modification_time
    timescale = u32(buf, off);
    off += 4;
    duration = u64(buf, off);
  } else {
    if (off + 16 > end) return { durationSec: null, creationDate: null };
    creation = u32(buf, off);
    off += 4; // creation_time
    off += 4; // modification_time
    timescale = u32(buf, off);
    off += 4;
    duration = u32(buf, off);
    // A version-0 duration of 0xFFFFFFFF is the "unknown" sentinel.
    if (duration === 0xffffffff) duration = 0;
  }
  const durationSec =
    timescale > 0 && duration > 0 ? duration / timescale : null;
  return { durationSec, creationDate: macTimeToDate(creation) };
}

// Handler types seen inside moov/trak/mdia/hdlr, gathered to decide video vs audio.
interface MoovFacts {
  durationSec: number | null;
  creationDate: string | null;
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
  hasLocation: boolean;
}

// Recursively gather the facts we need out of the moov box. Only descends the
// container boxes on the path to mvhd / hdlr / udta, so it stays cheap.
function scanMoov(buf: Buffer, start: number, end: number): MoovFacts {
  const facts: MoovFacts = {
    durationSec: null,
    creationDate: null,
    hasVideoTrack: false,
    hasAudioTrack: false,
    hasLocation: false,
  };
  const CONTAINER = new Set(["trak", "mdia", "minf", "stbl", "udta", "meta"]);
  const recurse = (s: number, e: number, depth: number) => {
    if (depth > 6) return;
    walkBoxes(buf, s, e, (box) => {
      if (box.type === "mvhd") {
        const m = parseMvhd(buf, box.start, box.end);
        if (m.durationSec != null) facts.durationSec = m.durationSec;
        if (m.creationDate) facts.creationDate = m.creationDate;
      } else if (box.type === "hdlr") {
        // hdlr: version(1)+flags(3)+pre_defined(4)+handler_type(4)…
        const ht = asciiAt(buf, box.start + 8, 4);
        if (ht === "vide") facts.hasVideoTrack = true;
        else if (ht === "soun") facts.hasAudioTrack = true;
      } else if (box.type === "©xyz") {
        // QuickTime location atom (©xyz) — presence only.
        facts.hasLocation = true;
      } else if (CONTAINER.has(box.type)) {
        // `meta` carries a 4-byte version/flags prefix before its child boxes.
        const childStart = box.type === "meta" ? box.start + 4 : box.start;
        recurse(childStart, box.end, depth + 1);
      }
    });
  };
  recurse(start, end, 0);
  // The Apple ISO6709 metadata KEY lives in moov/meta/keys as a plain string;
  // detect it by substring over the moov region (cheap, presence-only).
  if (
    !facts.hasLocation &&
    indexOfAscii(buf, start, end, "com.apple.quicktime.location.ISO6709") !== -1
  ) {
    facts.hasLocation = true;
  }
  return facts;
}

// Bounded ASCII substring search within [start, end).
function indexOfAscii(
  buf: Buffer,
  start: number,
  end: number,
  needle: string
): number {
  const hi = Math.min(end, buf.length);
  if (hi <= start) return -1;
  const idx = buf.indexOf(needle, start, "latin1");
  return idx !== -1 && idx < hi ? idx : -1;
}

// ISO-BMFF brands that mean AUDIO-only (an .m4a container).
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "F4A ", "F4B "]);

// Sniff an ISO-BMFF file whose box at offset 4 is "ftyp".
function sniffIsoBmff(buf: Buffer): VideoSniff | null {
  const majorBrand = asciiAt(buf, 8, 4);
  const isQuickTime = majorBrand === "qt  ";

  let moov: MoovFacts | null = null;
  walkBoxes(buf, 0, buf.length, (box) => {
    if (box.type === "moov" && !moov) {
      moov = scanMoov(buf, box.start, box.end);
    }
  });

  // Decide video vs audio: an explicit video track wins; else an audio-only
  // container (a video track absent + an audio track present, or an audio brand).
  const brandAudio = AUDIO_BRANDS.has(majorBrand);
  const facts: MoovFacts = moov ?? {
    durationSec: null,
    creationDate: null,
    hasVideoTrack: false,
    hasAudioTrack: false,
    hasLocation: false,
  };
  const audioOnly = brandAudio || (!facts.hasVideoTrack && facts.hasAudioTrack);
  const kind: VideoKind = audioOnly ? "audio" : "video";

  let mime: string;
  if (kind === "audio") mime = "audio/mp4";
  else if (isQuickTime) mime = "video/quicktime";
  else mime = "video/mp4";

  return {
    mime,
    container: isQuickTime ? "quicktime" : "mp4",
    kind,
    durationSec: facts.durationSec,
    creationDate: facts.creationDate,
    hasLocation: facts.hasLocation,
  };
}

// ── EBML (WebM / Matroska) ──────────────────────────────────────────────────

// Read an EBML variable-length integer at `off`. `keepMarker` keeps the
// length-marker bit set (element IDs are compared WITH it); size fields clear it.
// Returns the decoded value and the byte length, or null when it runs off the end.
function readVint(
  buf: Buffer,
  off: number,
  keepMarker: boolean
): { value: number; length: number } | null {
  if (off >= buf.length) return null;
  const first = buf[off];
  if (first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || off + length > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[off + i];
  return { value, length };
}

// Known EBML element IDs, as the numeric value of their marker-kept VINT.
const EBML = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
} as const;

interface EbmlFacts {
  durationSec: number | null;
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
}

// Walk the EBML master element in [start, end), collecting Duration/TimecodeScale
// (from Info) and TrackType (from Tracks/TrackEntry). Bounded + step-guarded.
function walkEbml(
  buf: Buffer,
  start: number,
  end: number,
  ctx: {
    timecodeScale: number;
    durationRaw: number | null;
    facts: EbmlFacts;
    trackType: number | null;
  },
  depth: number
): void {
  if (depth > 6) return;
  let pos = start;
  const limit = Math.min(end, buf.length);
  while (pos < limit) {
    const id = readVint(buf, pos, true);
    if (!id) break;
    const size = readVint(buf, pos + id.length, false);
    if (!size) break;
    const contentStart = pos + id.length + size.length;
    const contentEnd = Math.min(contentStart + size.value, limit);
    if (contentStart > limit) break;

    switch (id.value) {
      case EBML.Segment:
      case EBML.Info:
      case EBML.Tracks:
        walkEbml(buf, contentStart, contentEnd, ctx, depth + 1);
        break;
      case EBML.TrackEntry: {
        ctx.trackType = null;
        walkEbml(buf, contentStart, contentEnd, ctx, depth + 1);
        if (ctx.trackType === 1) ctx.facts.hasVideoTrack = true;
        else if (ctx.trackType === 2) ctx.facts.hasAudioTrack = true;
        break;
      }
      case EBML.TrackType: {
        if (size.value >= 1 && contentStart < limit)
          ctx.trackType = buf[contentStart];
        break;
      }
      case EBML.TimecodeScale: {
        let v = 0;
        for (let i = 0; i < size.value && contentStart + i < limit; i++)
          v = v * 256 + buf[contentStart + i];
        if (v > 0) ctx.timecodeScale = v;
        break;
      }
      case EBML.Duration: {
        if (size.value === 4 && contentStart + 4 <= limit)
          ctx.durationRaw = buf.readFloatBE(contentStart);
        else if (size.value === 8 && contentStart + 8 <= limit)
          ctx.durationRaw = buf.readDoubleBE(contentStart);
        break;
      }
      default:
        break;
    }
    const advance = id.length + size.length + size.value;
    if (advance <= 0) break;
    pos += advance;
  }
}

function sniffEbml(buf: Buffer): VideoSniff | null {
  const ctx = {
    timecodeScale: 1_000_000, // EBML default: 1 ms in nanoseconds
    durationRaw: null as number | null,
    facts: { durationSec: null, hasVideoTrack: false, hasAudioTrack: false },
    trackType: null as number | null,
  };
  walkEbml(buf, 0, buf.length, ctx, 0);
  const durationSec =
    ctx.durationRaw != null && ctx.durationRaw > 0
      ? (ctx.durationRaw * ctx.timecodeScale) / 1e9
      : null;
  const kind: VideoKind =
    ctx.facts.hasVideoTrack || !ctx.facts.hasAudioTrack ? "video" : "audio";
  return {
    mime: kind === "audio" ? "audio/webm" : "video/webm",
    container: "webm",
    kind,
    durationSec,
    // EBML DateUTC parsing is out of scope for phase 1 (rare from phones);
    // creation date defaults to today at the caller. Location metadata isn't
    // carried by a MediaRecorder/WebM clip, so nothing to flag.
    creationDate: null,
    hasLocation: false,
  };
}

// ── entry point ─────────────────────────────────────────────────────────────

// Detect an uploaded clip's container from its magic bytes and parse the header
// facts. Returns null for anything that isn't a recognized video/audio container
// (the caller rejects it — never trust the client-declared type).
export function sniffVideo(buffer: Buffer): VideoSniff | null {
  if (buffer.length < 12) return null;

  // ISO-BMFF: box at offset 4 is "ftyp".
  if (asciiAt(buffer, 4, 4) === "ftyp") return sniffIsoBmff(buffer);

  // EBML (WebM / Matroska): 1A 45 DF A3.
  if (bytesAt(buffer, 0, [0x1a, 0x45, 0xdf, 0xa3])) return sniffEbml(buffer);

  // Ogg (Vorbis/Opus voice notes): "OggS". Duration isn't cheap to compute
  // (last-page granule scan); the byte cap guards size, duration stays null.
  if (asciiAt(buffer, 0, 4) === "OggS") {
    return {
      mime: "audio/ogg",
      container: "ogg",
      kind: "audio",
      durationSec: null,
      creationDate: null,
      hasLocation: false,
    };
  }

  // MP3: an ID3 tag ("ID3") or an MPEG-audio frame sync (0xFF 0xEx). Duration
  // requires frame counting — out of scope; the byte cap guards size.
  if (
    asciiAt(buffer, 0, 3) === "ID3" ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return {
      mime: "audio/mpeg",
      container: "mp3",
      kind: "audio",
      durationSec: null,
      creationDate: null,
      hasLocation: false,
    };
  }

  return null;
}
