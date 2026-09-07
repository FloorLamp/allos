import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as audit from "@/lib/audit";
import * as auth from "@/lib/auth";
import * as backup from "@/lib/backup";
import * as connections from "@/lib/integrations/connections";
import * as replay from "@/lib/offline/writes";
import * as settings from "@/lib/settings";
import * as twoFactor from "@/lib/two-factor";
import * as trash from "@/lib/undo-delete-db";
import { runNotifyTick } from "@/lib/notifications/tick";

// Restore auth's real exports from the action-tier setup. This test drives the
// actual tick; only backup I/O and the sweep outcomes are stubbed.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

beforeEach(() => {
  vi.spyOn(backup, "runScheduledBackup").mockReturnValue({
    ran: false,
    failed: false,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("the notification tick's retention sweeps", () => {
  it("runs every sweep once with the configured retention windows", async () => {
    settings.setSetting("audit_retention_months", "6");
    settings.setSetting("trash_retention_days", "14");
    const auditSweep = vi.spyOn(audit, "pruneAuditEvents").mockReturnValue(2);
    const trashSweep = vi.spyOn(trash, "sweepDeletedRows").mockReturnValue(3);
    const sweeps = [
      vi.spyOn(replay, "sweepReplayedKeys").mockReturnValue(0),
      vi.spyOn(connections, "pruneSyncEvents").mockReturnValue(1),
      vi.spyOn(auth, "purgeExpiredSessions").mockReturnValue(1),
      vi.spyOn(twoFactor, "purgeExpiredTotpChallenges").mockReturnValue(1),
    ];

    expect(await runNotifyTick([], Date.now(), async () => false)).toBe(0);
    expect(auditSweep).toHaveBeenCalledExactlyOnceWith({ maxMonths: 6 });
    expect(trashSweep).toHaveBeenCalledExactlyOnceWith(14);
    for (const sweep of sweeps) expect(sweep).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["audit settings", "sessions"])(
    "continues cleanup without failing the tick when %s throws",
    async (failure) => {
      const fail = () => {
        throw new Error("cleanup unavailable");
      };
      if (failure === "audit settings")
        vi.spyOn(settings, "getAuditRetentionMonths").mockImplementation(fail);
      else vi.spyOn(auth, "purgeExpiredSessions").mockImplementation(fail);
      const challenges = vi
        .spyOn(twoFactor, "purgeExpiredTotpChallenges")
        .mockReturnValue(1);

      expect(await runNotifyTick([], Date.now(), async () => false)).toBe(0);
      expect(challenges).toHaveBeenCalledExactlyOnceWith();
    }
  );
});
