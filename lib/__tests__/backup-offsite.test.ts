import { describe, it, expect } from "vitest";
import {
  resolveOffsiteDir,
  planUploadMirror,
  type MirrorEntry,
} from "@/lib/backup-offsite";

// Pure decision logic for off-volume backup replication (#130): resolving the
// configured secondary destination and planning the incremental uploads mirror.
// The fs copy path is exercised in lib/__db_tests__/backup-offsite.test.ts.

describe("resolveOffsiteDir", () => {
  it("treats unset / empty / whitespace as no destination", () => {
    expect(resolveOffsiteDir(undefined)).toBeNull();
    expect(resolveOffsiteDir(null)).toBeNull();
    expect(resolveOffsiteDir("")).toBeNull();
    expect(resolveOffsiteDir("   ")).toBeNull();
  });

  it("returns a trimmed directory when set", () => {
    expect(resolveOffsiteDir("/mnt/backup")).toBe("/mnt/backup");
    expect(resolveOffsiteDir("  /mnt/backup  ")).toBe("/mnt/backup");
  });
});

describe("planUploadMirror", () => {
  const src: MirrorEntry[] = [
    { rel: "medical/1/a.pdf", size: 100 },
    { rel: "medical/1/b.pdf", size: 200 },
    { rel: "medical/2/c.pdf", size: 300 },
  ];

  it("copies everything when the destination is empty", () => {
    expect(planUploadMirror(src, [])).toEqual([
      "medical/1/a.pdf",
      "medical/1/b.pdf",
      "medical/2/c.pdf",
    ]);
  });

  it("skips files already present at the destination (same rel + size)", () => {
    const dest: MirrorEntry[] = [
      { rel: "medical/1/a.pdf", size: 100 },
      { rel: "medical/2/c.pdf", size: 300 },
    ];
    expect(planUploadMirror(src, dest)).toEqual(["medical/1/b.pdf"]);
  });

  it("re-copies a file whose size changed (partial/truncated earlier copy)", () => {
    const dest: MirrorEntry[] = [
      { rel: "medical/1/a.pdf", size: 100 },
      { rel: "medical/1/b.pdf", size: 199 }, // truncated
      { rel: "medical/2/c.pdf", size: 300 },
    ];
    expect(planUploadMirror(src, dest)).toEqual(["medical/1/b.pdf"]);
  });

  it("is append-only — extra destination-only files never appear in the plan", () => {
    const dest: MirrorEntry[] = [
      { rel: "medical/1/a.pdf", size: 100 },
      { rel: "medical/1/b.pdf", size: 200 },
      { rel: "medical/2/c.pdf", size: 300 },
      { rel: "medical/9/orphan.pdf", size: 999 }, // deleted at source
    ];
    expect(planUploadMirror(src, dest)).toEqual([]);
  });

  it("copies nothing when source is empty", () => {
    expect(planUploadMirror([], [{ rel: "x", size: 1 }])).toEqual([]);
  });
});
