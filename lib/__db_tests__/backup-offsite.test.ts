// DB INTEGRATION TIER — off-volume backup replication copy path (#130).
//
// The pure selection logic (resolveOffsiteDir / planUploadMirror) is unit-tested in
// lib/__tests__/backup-offsite.test.ts; this exercises the *fs side effects* of
// replicateToOffsite + listUploadFiles against throwaway temp directories: copying
// the verified snapshot + its sidecar off-volume, pruning the destination to the
// retention policy, and the incremental (append-only) uploads mirror. It imports
// lib/backup, which opens the db singleton (redirected at a per-file temp DB by
// setup.ts) — but replicateToOffsite here is passed explicit retention so it never
// reads settings; the db import is incidental.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replicateToOffsite, listUploadFiles } from "@/lib/backup";
import { verificationSidecarName } from "@/lib/backup-verify";
import { OFFSITE_SENTINEL } from "@/lib/backup-offsite";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Mark a temp dir as a verified, MOUNTED off-volume destination (#463): the
// replicator refuses to write into a root without the sentinel.
function markMounted(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OFFSITE_SENTINEL), "test");
}

function writeSnapshot(dir: string, name: string, body = "db"): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(
    path.join(dir, verificationSidecarName(name)),
    JSON.stringify({ integrity: "ok", checkedAt: new Date().toISOString() })
  );
}

function writeUpload(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

describe("replicateToOffsite (copy path)", () => {
  let srcDir: string;
  let destDir: string;
  let uploads: string;

  beforeEach(() => {
    srcDir = mkTmp("allos-offsite-src-");
    destDir = mkTmp("allos-offsite-dest-");
    uploads = mkTmp("allos-offsite-uploads-");
    // The destination is a real, verified mount for the happy-path cases below.
    markMounted(destDir);
  });

  it("returns replicated:false when no destination is configured", () => {
    const r = replicateToOffsite("allos-2026-07-10-0300.db", {
      destDir: null,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 7,
      keepWeekly: 8,
    });
    expect(r.replicated).toBe(false);
  });

  it("copies the snapshot + sidecar and mirrors uploads", () => {
    const name = "allos-2026-07-10-0300.db";
    writeSnapshot(srcDir, name);
    writeUpload(uploads, "medical/1/a.pdf", "AAA");
    writeUpload(uploads, "medical/2/b.pdf", "BBBBB");

    const r = replicateToOffsite(name, {
      destDir: destDir,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 7,
      keepWeekly: 8,
    });

    expect(r.replicated).toBe(true);
    expect(r.uploadsCopied).toBe(2);
    // Snapshot + sidecar landed in the destination root.
    expect(fs.existsSync(path.join(destDir, name))).toBe(true);
    expect(
      fs.existsSync(path.join(destDir, verificationSidecarName(name)))
    ).toBe(true);
    // Uploads mirrored under <dest>/uploads with the same tree.
    expect(
      fs.readFileSync(path.join(destDir, "uploads", "medical/1/a.pdf"), "utf8")
    ).toBe("AAA");
    expect(
      fs.readFileSync(path.join(destDir, "uploads", "medical/2/b.pdf"), "utf8")
    ).toBe("BBBBB");
  });

  it("is incremental — a second run copies only new upload files", () => {
    const name1 = "allos-2026-07-10-0300.db";
    writeSnapshot(srcDir, name1);
    writeUpload(uploads, "medical/1/a.pdf", "AAA");
    const first = replicateToOffsite(name1, {
      destDir,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 7,
      keepWeekly: 8,
    });
    expect(first.uploadsCopied).toBe(1);

    // Next day: one new upload; the existing one is unchanged.
    const name2 = "allos-2026-07-11-0300.db";
    writeSnapshot(srcDir, name2);
    writeUpload(uploads, "medical/1/c.pdf", "CCCC");
    const second = replicateToOffsite(name2, {
      destDir,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 7,
      keepWeekly: 8,
    });
    expect(second.uploadsCopied).toBe(1); // only c.pdf
    expect(
      fs.existsSync(path.join(destDir, "uploads", "medical/1/c.pdf"))
    ).toBe(true);
  });

  it("prunes the destination to the retention policy", () => {
    // Seed the destination with several old daily snapshots already present, then
    // replicate a fresh one with keepDaily:2 / keepWeekly:0 — older ones prune.
    for (const d of ["05", "06", "07", "08"]) {
      writeSnapshot(destDir, `allos-2026-07-${d}-0300.db`);
    }
    const name = "allos-2026-07-09-0300.db";
    writeSnapshot(srcDir, name);

    const r = replicateToOffsite(name, {
      destDir,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 2,
      keepWeekly: 0,
    });
    expect(r.replicated).toBe(true);

    const remaining = fs
      .readdirSync(destDir)
      .filter((n) => n.startsWith("allos-") && n.endsWith(".db"))
      .sort();
    // keepDaily:2 keeps the two newest (09 just written + 08); 05/06/07 pruned.
    expect(remaining).toEqual([
      "allos-2026-07-08-0300.db",
      "allos-2026-07-09-0300.db",
    ]);
    // Pruned snapshots' sidecars are removed too (no orphans).
    expect(
      fs.existsSync(
        path.join(destDir, verificationSidecarName("allos-2026-07-05-0300.db"))
      )
    ).toBe(false);
  });
});

describe("replicateToOffsite mount detection (#463)", () => {
  let srcDir: string;
  let uploads: string;

  beforeEach(() => {
    srcDir = mkTmp("allos-offsite-src-");
    uploads = mkTmp("allos-offsite-uploads-");
    writeSnapshot(srcDir, "allos-2026-07-10-0300.db");
  });

  it("skips (does not mkdir) when the destination root does not exist", () => {
    const missing = path.join(os.tmpdir(), "allos-offsite-not-mounted-xyz-123");
    fs.rmSync(missing, { recursive: true, force: true });

    const r = replicateToOffsite("allos-2026-07-10-0300.db", {
      destDir: missing,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 7,
      keepWeekly: 8,
    });

    expect(r.replicated).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/not mounted/i);
    // Crucially, the root was NOT created — no false durable backup.
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("skips when the root exists but has no sentinel (bare/unmounted mount point)", () => {
    const bare = mkTmp("allos-offsite-bare-"); // exists, but no sentinel written
    const r = replicateToOffsite("allos-2026-07-10-0300.db", {
      destDir: bare,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 7,
      keepWeekly: 8,
    });

    expect(r.replicated).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/sentinel|verified/i);
    // The snapshot was NOT copied into the unverified root.
    expect(fs.existsSync(path.join(bare, "allos-2026-07-10-0300.db"))).toBe(
      false
    );
  });

  it("replicates once the sentinel is present", () => {
    const dest = mkTmp("allos-offsite-mounted-");
    markMounted(dest);
    const r = replicateToOffsite("allos-2026-07-10-0300.db", {
      destDir: dest,
      sourceBackupsDir: srcDir,
      uploadsRoot: uploads,
      keepDaily: 7,
      keepWeekly: 8,
    });
    expect(r.replicated).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(fs.existsSync(path.join(dest, "allos-2026-07-10-0300.db"))).toBe(
      true
    );
  });
});

describe("listUploadFiles", () => {
  it("returns [] for a missing root", () => {
    expect(
      listUploadFiles(path.join(os.tmpdir(), "allos-does-not-exist-xyz"))
    ).toEqual([]);
  });

  it("walks nested files with relative paths + sizes", () => {
    const root = mkTmp("allos-uploads-walk-");
    writeUpload(root, "medical/1/a.pdf", "AAA");
    writeUpload(root, "medical/1/nested/b.pdf", "BB");
    const entries = listUploadFiles(root).sort((x, y) =>
      x.rel < y.rel ? -1 : 1
    );
    expect(entries).toEqual([
      { rel: path.join("medical", "1", "a.pdf"), size: 3 },
      { rel: path.join("medical", "1", "nested", "b.pdf"), size: 2 },
    ]);
  });
});
