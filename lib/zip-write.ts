// Minimal, dependency-free STORE-only ZIP WRITER (issue #18). The counterpart to
// the read-only lib/zip.ts: it builds a well-formed ZIP archive entry-by-entry so
// the full-account export can STREAM out one file at a time instead of holding the
// whole archive in memory (perf audit #8 spirit). Each entry's bytes are handed to
// the builder, which returns the local-file-header + data chunk to emit
// immediately; the central directory + end-of-central-directory record are emitted
// once at the end. Only the current entry is ever held by the builder.
//
// STORE (method 0, no compression) is deliberate: the biggest payloads are already
// compressed (PDFs/JPEGs), correctness beats a few saved bytes, and it keeps the
// writer symmetric with the hand-rolled reader — no zlib deflate stream to manage.
// The archive round-trips through readZip (verified in the unit test).
//
// Not supported (unneeded here): Zip64 (a single 4 GiB+ entry or 4 GiB+ total),
// encryption, and data descriptors (sizes/CRC are always known before the header,
// since each entry's bytes are fully in hand).

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// CRC-32 (IEEE 802.3, the polynomial ZIP uses), table-driven. Pure.
const CRC_TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface CentralRecord {
  nameBytes: Buffer;
  crc: number;
  size: number;
  offset: number;
}

// A fixed MS-DOS date/time (1980-01-01 00:00:00) — the reader ignores timestamps,
// and a constant keeps the archive byte-stable, so we don't leak a wall-clock time
// into every entry.
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

export class ZipBuilder {
  private offset = 0;
  private central: CentralRecord[] = [];

  // Add one file entry. Returns the bytes to write to the output stream now (local
  // header + stored data). Records the central-directory entry for end().
  file(name: string, data: Buffer): Buffer {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOC_SIG, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // general purpose: bit 11 = UTF-8 filename
    header.writeUInt16LE(0, 8); // method: STORE
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); // compressed size
    header.writeUInt32LE(data.length, 22); // uncompressed size
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra length

    this.central.push({
      nameBytes,
      crc,
      size: data.length,
      offset: this.offset,
    });
    this.offset += header.length + nameBytes.length + data.length;
    return Buffer.concat([header, nameBytes, data]);
  }

  // The central directory + EOCD record, to write after every file entry. Call once.
  end(): Buffer {
    const cdStart = this.offset;
    const parts: Buffer[] = [];
    for (const rec of this.central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(CEN_SIG, 0);
      h.writeUInt16LE(20, 4); // version made by
      h.writeUInt16LE(20, 6); // version needed
      h.writeUInt16LE(0x0800, 8); // UTF-8 filename bit
      h.writeUInt16LE(0, 10); // method: STORE
      h.writeUInt16LE(DOS_TIME, 12);
      h.writeUInt16LE(DOS_DATE, 14);
      h.writeUInt32LE(rec.crc, 16);
      h.writeUInt32LE(rec.size, 20); // compressed size
      h.writeUInt32LE(rec.size, 24); // uncompressed size
      h.writeUInt16LE(rec.nameBytes.length, 28);
      h.writeUInt16LE(0, 30); // extra length
      h.writeUInt16LE(0, 32); // comment length
      h.writeUInt16LE(0, 34); // disk number start
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(rec.offset, 42); // local header offset
      parts.push(h, rec.nameBytes);
    }
    const cd = Buffer.concat(parts);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // cd start disk
    eocd.writeUInt16LE(this.central.length, 8); // entries on this disk
    eocd.writeUInt16LE(this.central.length, 10); // total entries
    eocd.writeUInt32LE(cd.length, 12); // cd size
    eocd.writeUInt32LE(cdStart, 16); // cd offset
    eocd.writeUInt16LE(0, 20); // comment length

    this.offset += cd.length + eocd.length;
    return Buffer.concat([cd, eocd]);
  }
}
