// PURE EXIF reader for the shared photo core (#1119). Two jobs, both privacy-load-
// bearing, both unit-tested in lib/__tests__/photo-exif.test.ts:
//
//   1. HARVEST the one useful truth before the strip: the capture date
//      (DateTimeOriginal, falling back to DateTime) so a photo taken last Tuesday
//      and uploaded today defaults to Tuesday. GPS is DELIBERATELY never harvested
//      — no field of the returned summary ever carries a coordinate; the app has
//      no business storing location (#1119 product decision).
//   2. VERIFY the strip: after the ingest pipeline re-encodes (lib/photo/ingest.ts,
//      which drops all metadata), `readJpegExif(output)` must report
//      `hasExif: false` / `hasGps: false`. The pipeline refuses to store an output
//      that still carries metadata — defense in depth on top of the client-side
//      canvas re-encode (never trust the client) and sharp's default
//      metadata-dropping re-encode (never blindly trust the dependency either).
//
// Scope: JPEG APP1/Exif only. That is the only container the pipeline ever EMITS
// (every stored photo is a re-encoded JPEG), so the strip verification is complete
// for stored bytes. On the INPUT side, PNG/WebP metadata chunks (rare eXIf/XMP)
// are dropped by the same re-encode without being harvested — the capture-date
// default simply isn't available for them.
//
// The parser is a bounded, bounds-checked TIFF IFD walk — malformed input never
// throws, it just yields an empty summary.

export interface PhotoExifSummary {
  // An APP1 "Exif" segment is present at all (any metadata block).
  hasExif: boolean;
  // A GPS IFD pointer (tag 0x8825) is present. Detection only — coordinates are
  // never decoded, never returned.
  hasGps: boolean;
  // EXIF orientation (tag 0x0112), 1-8, or null. The ingest pipeline bakes it
  // into pixels (auto-orient) before the strip.
  orientation: number | null;
  // "YYYY-MM-DD" from DateTimeOriginal (0x9003), else DateTime (0x0132), else
  // null. Date only — time-of-day is not kept.
  captureDate: string | null;
}

export const EMPTY_EXIF_SUMMARY: PhotoExifSummary = {
  hasExif: false,
  hasGps: false,
  orientation: null,
  captureDate: null,
};

// EXIF stores "YYYY:MM:DD HH:MM:SS". Returns "YYYY-MM-DD" when the date part is
// real (rejects the all-zero placeholder some cameras write), else null.
export function exifDateToIso(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T]/.exec(value.trim() + " ");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Round-trip through Date to reject impossible days (Feb 30).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  )
    return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// TIFF field types we read. ASCII (2) and SHORT (3) / LONG (4) cover everything
// harvested; anything else is skipped.
const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

const MAX_IFD_ENTRIES = 512; // sanity cap — a real IFD has dozens

interface TiffReader {
  buf: Uint8Array;
  le: boolean; // little-endian ("II")
}

function u16(r: TiffReader, off: number): number | null {
  if (off < 0 || off + 2 > r.buf.length) return null;
  return r.le
    ? r.buf[off] | (r.buf[off + 1] << 8)
    : (r.buf[off] << 8) | r.buf[off + 1];
}

function u32(r: TiffReader, off: number): number | null {
  if (off < 0 || off + 4 > r.buf.length) return null;
  const b = r.buf;
  return r.le
    ? (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16)) + b[off + 3] * 0x1000000
    : b[off] * 0x1000000 +
        ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]);
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  // Offset (within the TIFF block) of the value bytes — inline when they fit in
  // the 4-byte value field, else the pointed-to location.
  valueOffset: number;
}

// Parse one IFD's entries. Returns [] on any structural problem.
function readIfd(r: TiffReader, ifdOffset: number): IfdEntry[] {
  const count = u16(r, ifdOffset);
  if (count == null || count === 0 || count > MAX_IFD_ENTRIES) return [];
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = ifdOffset + 2 + i * 12;
    const tag = u16(r, e);
    const type = u16(r, e + 2);
    const n = u32(r, e + 4);
    if (tag == null || type == null || n == null) return entries;
    const size = (TYPE_SIZES[type] ?? 0) * n;
    let valueOffset = e + 8;
    if (size > 4) {
      const ptr = u32(r, e + 8);
      if (ptr == null) continue;
      valueOffset = ptr;
    }
    entries.push({ tag, type, count: n, valueOffset });
  }
  return entries;
}

function readAscii(r: TiffReader, entry: IfdEntry): string | null {
  if (entry.type !== 2) return null;
  const len = Math.min(entry.count, 64);
  if (entry.valueOffset < 0 || entry.valueOffset + len > r.buf.length)
    return null;
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = r.buf[entry.valueOffset + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function readShortOrLong(r: TiffReader, entry: IfdEntry): number | null {
  if (entry.type === 3) return u16(r, entry.valueOffset);
  if (entry.type === 4) return u32(r, entry.valueOffset);
  return null;
}

// Parse a TIFF/EXIF block (the bytes after the "Exif\0\0" marker) into the
// harvested summary. Exposed for the fixture-builder tests; app code goes
// through readJpegExif.
export function readTiffExif(tiff: Uint8Array): PhotoExifSummary {
  const summary: PhotoExifSummary = { ...EMPTY_EXIF_SUMMARY, hasExif: true };
  if (tiff.length < 8) return summary;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49; // "II"
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d; // "MM"
  if (!le && !be) return summary;
  const r: TiffReader = { buf: tiff, le };
  if (u16(r, 2) !== 42) return summary;
  const ifd0Offset = u32(r, 4);
  if (ifd0Offset == null) return summary;

  let dateTime: string | null = null;
  let dateTimeOriginal: string | null = null;
  let exifIfdPtr: number | null = null;

  for (const entry of readIfd(r, ifd0Offset)) {
    switch (entry.tag) {
      case 0x0112: // Orientation
        summary.orientation = readShortOrLong(r, entry);
        break;
      case 0x0132: // DateTime
        dateTime = readAscii(r, entry);
        break;
      case 0x8769: // Exif IFD pointer
        exifIfdPtr = readShortOrLong(r, entry);
        break;
      case 0x8825: // GPS IFD pointer — PRESENCE only; never decoded.
        summary.hasGps = true;
        break;
    }
  }

  if (exifIfdPtr != null) {
    for (const entry of readIfd(r, exifIfdPtr)) {
      if (entry.tag === 0x9003) dateTimeOriginal = readAscii(r, entry); // DateTimeOriginal
    }
  }

  summary.captureDate =
    exifDateToIso(dateTimeOriginal) ?? exifDateToIso(dateTime);
  return summary;
}

// Walk a JPEG's segments and parse its APP1/Exif block, if any. Non-JPEG input
// (or a JPEG with no Exif segment) yields the empty summary.
export function readJpegExif(input: Uint8Array): PhotoExifSummary {
  const b = input;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return EMPTY_EXIF_SUMMARY;
  let i = 2;
  // Bounded walk: each iteration either advances past a well-formed segment or
  // bails, so this terminates on arbitrary bytes.
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return EMPTY_EXIF_SUMMARY; // desynced — not a segment
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return EMPTY_EXIF_SUMMARY; // EOI / SOS: no APP1 found
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return EMPTY_EXIF_SUMMARY;
    if (marker === 0xe1 && len >= 8) {
      const p = i + 4;
      if (
        b[p] === 0x45 && // "Exif\0\0"
        b[p + 1] === 0x78 &&
        b[p + 2] === 0x69 &&
        b[p + 3] === 0x66 &&
        b[p + 4] === 0 &&
        b[p + 5] === 0
      ) {
        return readTiffExif(b.subarray(p + 6, i + 2 + len));
      }
    }
    i += 2 + len;
  }
  return EMPTY_EXIF_SUMMARY;
}
