import { describe, expect, it } from "vitest";
import { ZipBuilder, crc32 } from "@/lib/zip-write";
import { readZip, isZip } from "@/lib/zip";

// The writer must produce archives the reader (lib/zip.ts) accepts — they are the
// two halves of the same dependency-free ZIP support, so a write→read round-trip is
// the contract test.

describe("crc32", () => {
  it("matches the known CRC-32 of an ASCII string", () => {
    // Standard reference vector: CRC-32("The quick brown fox jumps over the lazy dog")
    expect(
      crc32(Buffer.from("The quick brown fox jumps over the lazy dog"))
    ).toBe(0x414fa339);
    expect(crc32(Buffer.from(""))).toBe(0);
  });
});

describe("ZipBuilder", () => {
  function build(entries: { name: string; data: Buffer }[]): Buffer {
    const zip = new ZipBuilder();
    const parts: Buffer[] = [];
    for (const e of entries) parts.push(zip.file(e.name, e.data));
    parts.push(zip.end());
    return Buffer.concat(parts);
  }

  it("round-trips text + binary entries through readZip", () => {
    const files = [
      { name: "manifest.json", data: Buffer.from('{"app":"allos"}', "utf8") },
      {
        name: "datasets/body_metrics.csv",
        data: Buffer.from("date,weight\n", "utf8"),
      },
      {
        name: "medical-files/1-scan.bin",
        data: Buffer.from([0, 1, 2, 3, 255, 254]),
      },
    ];
    const archive = build(files);

    expect(isZip(archive)).toBe(true);
    const read = readZip(archive);
    expect(read.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (let i = 0; i < files.length; i++) {
      expect(read[i].data.equals(files[i].data)).toBe(true);
    }
  });

  it("handles UTF-8 filenames and empty files", () => {
    const files = [
      { name: "datasets/café.json", data: Buffer.from("[]", "utf8") },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ];
    const read = readZip(build(files));
    expect(read.map((e) => e.name)).toEqual([
      "datasets/café.json",
      "empty.txt",
    ]);
    expect(read[1].data.length).toBe(0);
  });

  it("produces a valid empty archive", () => {
    const archive = new ZipBuilder().end();
    expect(readZip(archive)).toEqual([]);
  });
});
