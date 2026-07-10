// DB INTEGRATION TIER — health endpoint integrity/staleness wiring (#131).
//
// Proves the pieces the pure health-status test can't: (1) a REAL SQLite
// `PRAGMA integrity_check` against a genuinely corrupted database file is
// detected as a failure and drives a non-200 health verdict; (2) the live
// integrity check on a healthy migrated DB records the cached marker the health
// route reads; (3) that cached marker round-trips into buildHealthStatus. The
// health route itself only READS these cached markers — it never runs the
// expensive PRAGMA — so this test exercises the write side (runLiveIntegrityCheck)
// plus the pure composition the route performs.
//
// Deterministic: :memory:/temp-file only, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/settings";
import { runLiveIntegrityCheck } from "@/lib/backup";
import { interpretIntegrityRows } from "@/lib/backup-verify";
import { buildHealthStatus } from "@/lib/health-status";

// The composition the health route does after reading the cached marker.
function healthFromMarker(integrityRaw: string | undefined) {
  const liveIntegrityOk =
    integrityRaw === undefined ? null : integrityRaw === "1";
  return buildHealthStatus({
    readOk: true,
    writeOk: true,
    liveIntegrityOk,
    now: new Date(),
  });
}

describe("live integrity → health verdict", () => {
  it("a healthy live DB records integrity ok=1 and stays 200", () => {
    // Force it to run this week regardless of prior marker state.
    setSetting("backup_live_integrity_week", "");
    const res = runLiveIntegrityCheck(new Date());
    expect(res.ran).toBe(true);
    expect(res.ok).toBe(true);
    expect(getSetting("backup_live_integrity_ok")).toBe("1");

    const health = healthFromMarker(getSetting("backup_live_integrity_ok"));
    expect(health.ok).toBe(true);
    expect(health.httpStatus).toBe(200);
  });

  it("the live DB's own integrity_check reports ok", () => {
    // Sanity: the real, migrated singleton DB is not corrupt.
    const interp = interpretIntegrityRows(db.pragma("integrity_check"));
    expect(interp.ok).toBe(true);
  });

  it("a genuinely corrupted DB file is detected → non-200", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-corrupt-"));
    const file = path.join(dir, "corrupt.db");
    try {
      // Build a real multi-page DB (a table with an index over enough rows to
      // span several b-tree pages), then close it so the file is flushed.
      const seed = new Database(file);
      seed.pragma("journal_mode = DELETE"); // single-file, no WAL sidecar to garble
      seed.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      seed.exec("CREATE INDEX i_t_v ON t(v)");
      const ins = seed.prepare("INSERT INTO t(v) VALUES (?)");
      const tx = seed.transaction(() => {
        for (let n = 0; n < 2000; n++) ins.run(`row-${n}-${"x".repeat(40)}`);
      });
      tx();
      seed.close();

      // Corrupt the b-tree pages: overwrite a wide swath after the page-1 header
      // (so the file still opens) with garbage. This mangles table/index pages,
      // which integrity_check must flag.
      const buf = fs.readFileSync(file);
      expect(buf.length).toBeGreaterThan(8192);
      buf.fill(0xa5, 4096, Math.min(buf.length, 4096 + 32768));
      fs.writeFileSync(file, buf);

      // Re-open and run the same interpretation runLiveIntegrityCheck uses. A
      // malformed image may make the PRAGMA itself throw; mirror the check's
      // catch → treat a throw as a failure too.
      let ok: boolean;
      try {
        const reopened = new Database(file);
        try {
          ok = interpretIntegrityRows(reopened.pragma("integrity_check")).ok;
        } finally {
          reopened.close();
        }
      } catch {
        ok = false;
      }
      expect(ok).toBe(false);

      // The cached marker for a failed check is "0" → health is non-200.
      const health = healthFromMarker("0");
      expect(health.ok).toBe(false);
      expect(health.reason).toBe("integrity-failed");
      expect(health.httpStatus).toBe(503);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
