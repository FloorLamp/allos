// SYNTHETIC EXIF fixture builder for the photo-core tests (#1119). Constructs a
// minimal, valid APP1/Exif segment — optionally carrying a DateTimeOriginal, a
// DateTime, an orientation, and a GPS IFD — and can splice it into a real JPEG so
// every tier (pure parser tests, the DB/action-tier strip-verification tests) can
// exercise "GPS-tagged photo in → clean photo out" without ever committing a real
// photograph. Every value written here is OBVIOUSLY synthetic (fixed fictional
// coordinates, fixture dates); no real capture metadata exists anywhere in the
// repo, per the no-real-PHI rule.
//
// Test-support only: no app runtime path imports this module.

export interface ExifFixtureOptions {
  dateTimeOriginal?: string; // "YYYY:MM:DD HH:MM:SS"
  dateTime?: string;
  orientation?: number;
  gps?: boolean; // write a GPS IFD with synthetic fictional coordinates
}

const LE = true; // fixture always writes little-endian ("II")

function w16(arr: number[], v: number) {
  if (LE) arr.push(v & 0xff, (v >> 8) & 0xff);
}

function w32(arr: number[], v: number) {
  if (LE)
    arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  inline?: number[]; // value bytes when they fit in 4
  data?: number[]; // out-of-line value bytes (offset assigned at layout time)
}

function ascii(s: string): number[] {
  const out: number[] = [];
  for (const c of s) out.push(c.charCodeAt(0));
  out.push(0);
  return out;
}

function rational(num: number, den: number): number[] {
  const out: number[] = [];
  w32(out, num);
  w32(out, den);
  return out;
}

// Serialize one IFD, appending out-of-line data to `heap` (whose first byte
// lands at absolute offset `heapBase`). Entries must already be sorted by tag.
function writeIfd(
  entries: Entry[],
  heap: number[],
  heapBase: number
): number[] {
  const out: number[] = [];
  w16(out, entries.length);
  for (const e of entries) {
    w16(out, e.tag);
    w16(out, e.type);
    w32(out, e.count);
    if (e.data && e.data.length > 4) {
      w32(out, heapBase + heap.length);
      heap.push(...e.data);
    } else {
      const v = (e.data ?? e.inline ?? []).slice(0, 4);
      while (v.length < 4) v.push(0);
      out.push(...v);
    }
  }
  w32(out, 0); // no next IFD
  return out;
}

function ifdSize(entries: Entry[]): number {
  return 2 + entries.length * 12 + 4;
}

// The TIFF block (what follows "Exif\0\0" in an APP1 segment).
export function buildTiffBlock(opts: ExifFixtureOptions): Buffer {
  const ifd0: Entry[] = [];
  const exifIfd: Entry[] = [];
  const gpsIfd: Entry[] = [];

  if (opts.orientation != null) {
    const v: number[] = [];
    w16(v, opts.orientation);
    ifd0.push({ tag: 0x0112, type: 3, count: 1, inline: v });
  }
  if (opts.dateTime)
    ifd0.push({ tag: 0x0132, type: 2, count: 20, data: ascii(opts.dateTime) });
  if (opts.dateTimeOriginal)
    exifIfd.push({
      tag: 0x9003,
      type: 2,
      count: 20,
      data: ascii(opts.dateTimeOriginal),
    });
  if (opts.gps) {
    // Synthetic, fictional coordinates (0-ish lat/long over open ocean) — the
    // parser never decodes these; they exist so a strip test has real GPS bytes
    // to make disappear.
    gpsIfd.push({ tag: 0x0001, type: 2, count: 2, inline: ascii("N") });
    gpsIfd.push({
      tag: 0x0002,
      type: 5,
      count: 3,
      data: [...rational(1, 1), ...rational(2, 1), ...rational(3, 1)],
    });
  }

  // Layout: header(8) → IFD0 → Exif IFD → GPS IFD → heap.
  const pointers: Entry[] = [];
  const ifd0Offset = 8;
  let cursor =
    ifd0Offset +
    ifdSize(
      ifd0.concat(
        exifIfd.length ? [{ tag: 0x8769, type: 4, count: 1 }] : [],
        gpsIfd.length ? [{ tag: 0x8825, type: 4, count: 1 }] : []
      )
    );
  let exifIfdOffset = 0;
  let gpsIfdOffset = 0;
  if (exifIfd.length) {
    exifIfdOffset = cursor;
    cursor += ifdSize(exifIfd);
    const v: number[] = [];
    w32(v, exifIfdOffset);
    pointers.push({ tag: 0x8769, type: 4, count: 1, inline: v });
  }
  if (gpsIfd.length) {
    gpsIfdOffset = cursor;
    cursor += ifdSize(gpsIfd);
    const v: number[] = [];
    w32(v, gpsIfdOffset);
    pointers.push({ tag: 0x8825, type: 4, count: 1, inline: v });
  }
  const heapBase = cursor;
  const heap: number[] = [];

  const ifd0Full = ifd0.concat(pointers).sort((a, b) => a.tag - b.tag);

  const ifd0Bytes = writeIfd(ifd0Full, heap, heapBase);
  const exifBytes = exifIfd.length ? writeIfd(exifIfd, heap, heapBase) : [];
  const gpsBytes = gpsIfd.length ? writeIfd(gpsIfd, heap, heapBase) : [];

  const header: number[] = [0x49, 0x49]; // "II"
  w16(header, 42);
  w32(header, ifd0Offset);

  return Buffer.from([
    ...header,
    ...ifd0Bytes,
    ...exifBytes,
    ...gpsBytes,
    ...heap,
  ]);
}

// A full APP1 segment: FF E1 <len> "Exif\0\0" <tiff>.
export function buildExifApp1(opts: ExifFixtureOptions): Buffer {
  const tiff = buildTiffBlock(opts);
  const payload = Buffer.concat([
    Buffer.from([0x45, 0x78, 0x69, 0x66, 0, 0]), // "Exif\0\0"
    tiff,
  ]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([seg, payload]);
}

// Splice the synthetic APP1 right after SOI of a real JPEG — the result is a
// valid JPEG that decoders (and libvips) read normally, now carrying EXIF.
export function spliceExifIntoJpeg(
  jpeg: Buffer,
  opts: ExifFixtureOptions
): Buffer {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8)
    throw new Error("fixture: not a JPEG");
  return Buffer.concat([
    jpeg.subarray(0, 2),
    buildExifApp1(opts),
    jpeg.subarray(2),
  ]);
}

// A parser-only "JPEG": SOI + APP1 + EOI. Not decodable as an image; enough for
// the pure segment-walk tests.
export function buildMinimalExifJpeg(opts: ExifFixtureOptions): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    buildExifApp1(opts),
    Buffer.from([0xff, 0xd9]),
  ]);
}
