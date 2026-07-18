// SERVER-ACTION TIER — cycle-log actions (issue #714).
//
// Drives the real one-tap start/end + add/edit/delete cycle actions through the (mocked)
// auth guard against a real temp DB. Asserts the auth gate (requireWriteAccess), the rows
// written, and the typed error results.

import { describe, it, expect, beforeEach } from "vitest";
import {
  startPeriodAction,
  endPeriodAction,
  saveCycleAction,
  deleteCycleAction,
} from "@/app/(app)/medical/cycles/actions";
import { today } from "@/lib/db";
import {
  listCyclePeriods,
  getOpenPeriod,
  getCycleRow,
} from "@/lib/cycle-store";
import { createLogin, createProfile, actAs, fd } from "./harness";

describe("cycle actions", () => {
  let profileId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Cycle Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
  });

  it("one-tap start opens a period; a second tap does not duplicate", async () => {
    expect(await startPeriodAction(fd({}))).toEqual({ ok: true });
    const open = getOpenPeriod(profileId);
    expect(open).not.toBeNull();
    expect(open!.period_start).toBe(today(profileId));
    expect(open!.period_end).toBeNull();

    // Second tap while open — no new row.
    await startPeriodAction(fd({}));
    expect(listCyclePeriods(profileId).length).toBe(1);
  });

  it("one-tap end closes the open period; ending with none open errors", async () => {
    // Nothing open yet.
    const none = await endPeriodAction(fd({}));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/No period is open/);

    await startPeriodAction(fd({}));
    const ended = await endPeriodAction(fd({}));
    expect(ended).toEqual({ ok: true });
    expect(getOpenPeriod(profileId)).toBeNull();
    const row = listCyclePeriods(profileId)[0];
    expect(row.period_end).toBe(today(profileId));
  });

  it("saveCycleAction creates then edits a period", async () => {
    const created = await saveCycleAction(
      fd({
        period_start: "2026-03-01",
        period_end: "2026-03-05",
        flow: "medium",
        note: "  day 1 cramps  ",
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = getCycleRow(profileId, created.id)!;
    expect(row.period_start).toBe("2026-03-01");
    expect(row.period_end).toBe("2026-03-05");
    expect(row.flow).toBe("medium");
    expect(row.note).toBe("day 1 cramps"); // trimmed

    const edited = await saveCycleAction(
      fd({
        id: created.id,
        period_start: "2026-03-01",
        period_end: "2026-03-06",
        flow: "heavy",
        note: "",
      })
    );
    expect(edited).toEqual({ ok: true, id: created.id });
    const after = getCycleRow(profileId, created.id)!;
    expect(after.period_end).toBe("2026-03-06");
    expect(after.flow).toBe("heavy");
    expect(after.note).toBeNull();
  });

  it("rejects invalid dates and an end before the start", async () => {
    const bad = await saveCycleAction(fd({ period_start: "not-a-date" }));
    expect(bad.ok).toBe(false);
    const backwards = await saveCycleAction(
      fd({ period_start: "2026-03-10", period_end: "2026-03-01" })
    );
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.error).toMatch(/on or after/);
    expect(listCyclePeriods(profileId).length).toBe(0);
  });

  it("deleteCycleAction removes a period; a bad id errors", async () => {
    const created = await saveCycleAction(fd({ period_start: "2026-03-01" }));
    if (!created.ok) throw new Error("setup failed");
    expect(await deleteCycleAction(fd({ id: created.id }))).toEqual({
      ok: true,
    });
    expect(listCyclePeriods(profileId).length).toBe(0);
    const missing = await deleteCycleAction(fd({ id: 99999 }));
    expect(missing.ok).toBe(false);
  });

  it("a read-only grant cannot write", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("RO Subject", login.id);
    actAs(login, profile, "read");
    await expect(startPeriodAction(fd({}))).rejects.toThrow(/read-only/);
    await expect(
      saveCycleAction(fd({ period_start: "2026-03-01" }))
    ).rejects.toThrow(/read-only/);
  });
});
