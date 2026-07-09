import { describe, it, expect } from "vitest";
import {
  interpretIntegrityRows,
  verificationSidecarName,
  backupAgeHours,
  isLiveIntegrityCheckDue,
  decideRestore,
} from "../backup-verify";

describe("interpretIntegrityRows", () => {
  it("treats a single 'ok' row as healthy", () => {
    expect(interpretIntegrityRows([{ integrity_check: "ok" }])).toEqual({
      ok: true,
    });
  });

  it("accepts bare-string rows too", () => {
    expect(interpretIntegrityRows(["ok"])).toEqual({ ok: true });
  });

  it("flags error rows and joins the detail", () => {
    const r = interpretIntegrityRows([
      { integrity_check: "row 3 missing from index idx" },
      { integrity_check: "wrong # of entries in index idx" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("row 3 missing");
    expect(r.detail).toContain("wrong # of entries");
  });

  it("treats an empty / non-array result as a failure", () => {
    expect(interpretIntegrityRows([]).ok).toBe(false);
    expect(interpretIntegrityRows(null).ok).toBe(false);
    expect(interpretIntegrityRows(undefined).ok).toBe(false);
  });

  it("does not treat 'ok' plus extra rows as healthy", () => {
    expect(interpretIntegrityRows([{ c: "ok" }, { c: "boom" }]).ok).toBe(false);
  });

  it("caps detail at the first 10 messages", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      integrity_check: `err${i}`,
    }));
    const r = interpretIntegrityRows(rows);
    expect(r.ok).toBe(false);
    expect(r.detail!.split("; ")).toHaveLength(10);
  });
});

describe("verificationSidecarName", () => {
  it("appends .json (not a .db name)", () => {
    const n = verificationSidecarName("allos-2026-07-06-0305.db");
    expect(n).toBe("allos-2026-07-06-0305.db.json");
    expect(n.endsWith(".db")).toBe(false);
  });
});

describe("backupAgeHours", () => {
  const now = new Date("2026-07-09T12:00:00Z");

  it("returns null when never backed up", () => {
    expect(backupAgeHours(null, now)).toBeNull();
    expect(backupAgeHours(undefined, now)).toBeNull();
    expect(backupAgeHours("", now)).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(backupAgeHours("not-a-date", now)).toBeNull();
  });

  it("computes whole-hour ages", () => {
    expect(backupAgeHours("2026-07-09T06:00:00Z", now)).toBe(6);
    expect(backupAgeHours("2026-07-08T12:00:00Z", now)).toBe(24);
  });

  it("clamps future timestamps (clock skew) to 0", () => {
    expect(backupAgeHours("2026-07-09T18:00:00Z", now)).toBe(0);
  });

  it("rounds to 2 decimals", () => {
    expect(backupAgeHours("2026-07-09T11:30:00Z", now)).toBe(0.5);
  });
});

describe("isLiveIntegrityCheckDue", () => {
  it("is due when never run", () => {
    expect(isLiveIntegrityCheckDue(undefined, "2026-W28")).toBe(true);
    expect(isLiveIntegrityCheckDue(null, "2026-W28")).toBe(true);
  });

  it("is not due within the same ISO week", () => {
    expect(isLiveIntegrityCheckDue("2026-W28", "2026-W28")).toBe(false);
  });

  it("is due once the week rolls over", () => {
    expect(isLiveIntegrityCheckDue("2026-W27", "2026-W28")).toBe(true);
  });
});

describe("decideRestore", () => {
  it("proceeds when the snapshot is ok and the app is stopped", () => {
    expect(
      decideRestore({ snapshotOk: true, appRunning: false, force: false })
    ).toEqual({ proceed: true });
  });

  it("refuses while the app is running", () => {
    expect(
      decideRestore({ snapshotOk: true, appRunning: true, force: false })
    ).toEqual({ proceed: false, reason: "app-running" });
  });

  it("refuses a snapshot that failed integrity", () => {
    expect(
      decideRestore({ snapshotOk: false, appRunning: false, force: false })
    ).toEqual({ proceed: false, reason: "snapshot-failed-integrity" });
  });

  it("app-running takes precedence over a bad snapshot", () => {
    expect(
      decideRestore({ snapshotOk: false, appRunning: true, force: false })
        .reason
    ).toBe("app-running");
  });

  it("force overrides every refusal", () => {
    expect(
      decideRestore({ snapshotOk: false, appRunning: true, force: true })
    ).toEqual({ proceed: true });
  });
});
