import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { readZip, isZip, ZipError } from "@/lib/zip";

// Build a minimal but valid ZIP (central directory + EOCD) from a set of files,
// so we can test the reader without a zip dependency. CRC fields are left 0 —
// the reader doesn't verify them.
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const comp = zlib.deflateRawSync(f.data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, comp);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); // method
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + comp.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

describe("readZip", () => {
  it("round-trips deflated entries", () => {
    const files = [
      { name: "IHE_XDM/DOC0001.XML", data: Buffer.from("<ClinicalDocument/>") },
      { name: "METADATA.XML", data: Buffer.from("<meta/>") },
    ];
    const zip = buildZip(files);
    expect(isZip(zip)).toBe(true);
    const out = readZip(zip);
    expect(out.map((e) => e.name)).toEqual([
      "IHE_XDM/DOC0001.XML",
      "METADATA.XML",
    ]);
    expect(out[0].data.toString("utf8")).toBe("<ClinicalDocument/>");
    expect(out[1].data.toString("utf8")).toBe("<meta/>");
  });

  it("handles a larger payload", () => {
    const big = Buffer.from("x".repeat(50_000));
    const out = readZip(buildZip([{ name: "big.xml", data: big }]));
    expect(out[0].data.length).toBe(50_000);
  });

  it("isZip is false for non-zip input", () => {
    expect(isZip(Buffer.from("not a zip"))).toBe(false);
    expect(isZip(Buffer.from("PK"))).toBe(false); // too short
  });

  it("throws on a buffer with no end-of-central-directory", () => {
    expect(() => readZip(Buffer.from("garbage".repeat(10)))).toThrow(ZipError);
  });
});
