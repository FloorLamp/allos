import zlib from "node:zlib";

// Minimal, dependency-free ZIP reader — just enough to unwrap an IHE XDM package
// (the .zip / .xdm a patient downloads from MyChart, which wraps the C-CDA XML).
// Reads the central directory (robust to data descriptors, unlike scanning local
// headers) and inflates STORED (0) and DEFLATE (8) entries. Zip64 and encryption
// are not supported — XDM health-summary packages are small and use neither.

export class ZipError extends Error {}

// Hard cap on a single inflated entry. XDM health-summary packages are small
// (a CCD XML + a stylesheet); this bounds a malicious/corrupt DEFLATE entry so
// a decompression bomb throws instead of allocating gigabytes and OOM-killing
// the process. inflateRawSync rejects with a RangeError once output exceeds it.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// A buffer is a ZIP if it starts with a local-file-header (or empty-archive EOCD)
// signature.
export function isZip(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const sig = buf.readUInt32LE(0);
  return sig === LOC_SIG || sig === EOCD_SIG;
}

export function readZip(buf: Buffer): ZipEntry[] {
  // Locate the End Of Central Directory record, scanning back over the optional
  // trailing comment (max 65535 bytes).
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Not a valid ZIP archive.");

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // Skip directory entries (no data).
    if (!name.endsWith("/") && buf.readUInt32LE(localOffset) === LOC_SIG) {
      // Local header name/extra lengths are authoritative for the data offset.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let data: Buffer;
      if (method === 0) {
        if (raw.length > MAX_ENTRY_BYTES)
          throw new ZipError("ZIP entry exceeds the size limit.");
        data = Buffer.from(raw);
      } else if (method === 8) {
        try {
          data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
        } catch {
          throw new ZipError("ZIP entry is corrupt or exceeds the size limit.");
        }
      } else
        throw new ZipError(`Unsupported ZIP compression method ${method}.`);
      entries.push({ name, data });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
