// PURE ZIP central-directory parsing — the index half of the reader, split out so a
// caller can decide WHICH entries to inflate before paying for any of them.
//
// `lib/zip.ts`'s readZip inflates every entry into one array. That is exactly right
// for an XDM health summary (a handful of small members) and exactly wrong for a
// Google Takeout export, where ~81% of 1.4 GB is ML sensor data nobody will ever
// read and the useful part is ~2% of the entries. Inflating everything there is not
// a slow path, it is an impossible one.
//
// So this module reads only the CENTRAL DIRECTORY — names, sizes and offsets, no
// entry bytes — and hands back an index. The caller filters it by name and inflates
// the survivors one at a time (see readIndexedEntry in the fs-backed reader). No fs
// here: every function takes Buffers, so the format handling is unit-tested without
// a fixture archive.
//
// Same limits and same unsupported set as lib/zip.ts: no Zip64, no encryption.

import zlib from "node:zlib";

export class ZipIndexError extends Error {}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// The fixed part of an End Of Central Directory record.
export const EOCD_MIN_BYTES = 22;
// A ZIP comment is a 16-bit length, so the EOCD starts at most this far from the end.
export const EOCD_MAX_SCAN = EOCD_MIN_BYTES + 0xffff;

// A Takeout export runs to ~1100 entries; 65535 is the format's own 16-bit ceiling
// for a non-Zip64 archive, so anything beyond it is malformed rather than merely big.
const MAX_ENTRIES = 65_535;
// Cap on a SINGLE inflated entry. The largest thing this importer legitimately reads
// is a multi-MB JSON day file; 64 MB bounds a decompression bomb the same way
// lib/zip.ts does, and is checked per entry rather than in aggregate because the
// caller inflates one at a time and never accumulates.
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export interface ZipIndexEntry {
  name: string;
  // Compression method: 0 = STORE, 8 = DEFLATE. Anything else is rejected at read.
  method: number;
  compSize: number;
  uncompSize: number;
  // Offset of the LOCAL file header. The data start can only be computed after
  // reading that header — the central directory's name/extra lengths are not
  // authoritative for it (see localDataOffset).
  localOffset: number;
}

// Locate the EOCD within a buffer holding the archive's TAIL. Returns the offset
// RELATIVE TO THAT BUFFER, or -1. Scans backwards so a comment containing the
// signature can't shadow the real record.
export function findEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_MIN_BYTES; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export interface EocdInfo {
  entryCount: number;
  cdOffset: number;
  cdSize: number;
}

// Read the entry count and central-directory location out of an EOCD record.
export function parseEocd(tail: Buffer, eocdAt: number): EocdInfo {
  if (eocdAt < 0 || eocdAt + EOCD_MIN_BYTES > tail.length)
    throw new ZipIndexError("Not a valid ZIP archive.");
  return {
    entryCount: tail.readUInt16LE(eocdAt + 10),
    cdSize: tail.readUInt32LE(eocdAt + 12),
    cdOffset: tail.readUInt32LE(eocdAt + 16),
  };
}

// Parse the central directory into an index. `cd` must hold the whole directory.
// Directory entries (trailing "/") carry no data and are dropped. A truncated or
// desynchronized record stops the walk rather than throwing: a partially readable
// archive should yield what it can, and the caller reports the shortfall.
export function parseCentralDirectory(
  cd: Buffer,
  entryCount: number
): ZipIndexEntry[] {
  if (entryCount > MAX_ENTRIES)
    throw new ZipIndexError("ZIP has too many entries.");
  const out: ZipIndexEntry[] = [];
  let p = 0;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) break;
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    if (!name.endsWith("/"))
      out.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// The absolute offset of an entry's DATA, given the first 30 bytes of its local
// header. The local header's own name/extra lengths are authoritative — they can
// differ from the central directory's, which is why the data offset cannot be
// derived from the index alone.
export function localDataOffset(header: Buffer, localOffset: number): number {
  if (header.length < 30 || header.readUInt32LE(0) !== LOC_SIG)
    throw new ZipIndexError("ZIP entry has no local header.");
  return localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

// Inflate one entry's raw bytes. STORE is copied, DEFLATE is inflated under the
// per-entry ceiling; anything else is refused rather than guessed at.
export function inflateEntry(raw: Buffer, method: number): Buffer {
  if (method === 0) {
    if (raw.length > MAX_ENTRY_BYTES)
      throw new ZipIndexError("ZIP entry exceeds the size limit.");
    return Buffer.from(raw);
  }
  if (method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      throw new ZipIndexError(
        "ZIP entry is corrupt or exceeds the size limit."
      );
    }
  }
  throw new ZipIndexError(`Unsupported ZIP compression method ${method}.`);
}
