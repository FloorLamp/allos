// SERVER-ACTION TIER — the Backups card write path (issue #131, #1869 item 2).
// `backup_staleness_hours` used to be read by /api/health with NO writer anywhere
// (the documented alarm was configurable only by hand-editing the DB); the Backups
// card now carries a Stale alarm field, and this proves the write path: the value
// round-trips through saveBackupSettings into the global settings tier, an
// out-of-range submit keeps the stored value instead of disabling the alarm, and
// the read clamp falls back to the 48h default over a hand-edited garbage row.

import { describe, it, expect } from "vitest";
import { saveBackupSettings } from "@/app/(app)/settings/server/actions";
import {
  getBackupSettings,
  getSetting,
  setSetting,
  deleteSetting,
} from "@/lib/settings";
import { DEFAULT_BACKUP_STALENESS_HOURS } from "@/lib/health-status";
import { createLogin, createProfile, actAs, fd } from "./harness";

function actAsAdmin(): void {
  const login = createLogin({ role: "admin" });
  const profile = createProfile(`backup-admin-${login.id}`, login.id);
  actAs(login, profile);
}

describe("saveBackupSettings — staleness threshold (global tier)", () => {
  it("round-trips the stale alarm alongside retention", async () => {
    actAsAdmin();
    await saveBackupSettings(
      fd({
        backup_enabled: "1",
        backup_hour: "3",
        backup_keep_daily: "7",
        backup_keep_weekly: "8",
        backup_staleness_hours: "36",
      })
    );
    expect(getSetting("backup_staleness_hours")).toBe("36");
    expect(getBackupSettings().stalenessHours).toBe(36);
  });

  it("keeps the stored value on an out-of-range submit (never disables the alarm)", async () => {
    actAsAdmin();
    setSetting("backup_staleness_hours", "36");
    await saveBackupSettings(
      fd({
        backup_enabled: "1",
        backup_hour: "3",
        backup_keep_daily: "7",
        backup_keep_weekly: "8",
        backup_staleness_hours: "0",
      })
    );
    expect(getBackupSettings().stalenessHours).toBe(36);
  });

  it("reads a garbage or absent stored value as the 48h default", () => {
    setSetting("backup_staleness_hours", "soon");
    expect(getBackupSettings().stalenessHours).toBe(
      DEFAULT_BACKUP_STALENESS_HOURS
    );
    deleteSetting("backup_staleness_hours");
    expect(getBackupSettings().stalenessHours).toBe(
      DEFAULT_BACKUP_STALENESS_HOURS
    );
  });
});
