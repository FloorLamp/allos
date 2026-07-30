// SERVER-ACTION TIER — cycle-log actions (issue #714).
//
// Drives the real one-tap start/end + add/edit/delete cycle actions through the (mocked)
// auth guard against a real temp DB. Asserts the auth gate (requireWriteAccess), the rows
// written, and the typed error results.

import { describe, it, expect, beforeEach } from "vitest";
import {
  startPeriodAction,
  endPeriodAction,
  reopenPeriodAction,
  saveCycleAction,
  deleteCycleAction,
} from "@/app/(app)/medical/cycles/actions";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  listCyclePeriods,
  getOpenPeriod,
  getCycleRow,
} from "@/lib/cycle-store";
import { createLogin, createProfile, actAs, fd } from "./harness";

// A recorded period `startAgo`..`endAgo` days before this profile's today (endAgo null =
// still open). Direct insert so a test can set up a state the guarded actions refuse to
// produce.
function seedPeriod(
  profileId: number,
  startAgo: number,
  endAgo: number | null
): void {
  const anchor = today(profileId);
  db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end) VALUES (?, ?, ?)`
  ).run(
    profileId,
    shiftDateStr(anchor, -startAgo),
    endAgo == null ? null : shiftDateStr(anchor, -endAgo)
  );
}

describe("cycle actions", () => {
  let profileId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Cycle Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
  });

  it("one-tap start opens a period; a second tap SAYS a period is already open", async () => {
    expect(await startPeriodAction(fd({}))).toEqual({ ok: true });
    const open = getOpenPeriod(profileId);
    expect(open).not.toBeNull();
    expect(open!.period_start).toBe(today(profileId));
    expect(open!.period_end).toBeNull();

    // Second tap while open — no new row, and NOT reported as a success (#1681 bug 1:
    // this returned { ok: true } and the UI toasted "Period started").
    const again = await startPeriodAction(fd({}));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already open/);
    expect(listCyclePeriods(profileId).length).toBe(1);
  });

  it("start refuses a same-day duplicate instead of confirming it (#1681)", async () => {
    // The owner-reported reproduction: start today, end today → the row is closed, and
    // the old control offered "Period started today" again.
    seedPeriod(profileId, 0, 0);
    const dup = await startPeriodAction(fd({}));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/already starts today/);
    expect(listCyclePeriods(profileId).length).toBe(1);
  });

  it("start refuses a back-to-back period after a recent end (#1681 bug 2)", async () => {
    seedPeriod(profileId, 7, 2); // ended 2 days ago
    const soon = await startPeriodAction(fd({}));
    expect(soon.ok).toBe(false);
    if (!soon.ok) {
      expect(soon.error).toMatch(/too recently/);
      expect(soon.error).toContain(shiftDateStr(today(profileId), -2));
    }
    expect(listCyclePeriods(profileId).length).toBe(1);
  });

  it("one-tap 'Still bleeding' reopens a just-ended period, and refuses an old one", async () => {
    seedPeriod(profileId, 4, 0); // ended today
    expect(await reopenPeriodAction(fd({}))).toEqual({ ok: true });
    expect(getOpenPeriod(profileId)).not.toBeNull();

    // Close it again and age it out: the affordance must not resurrect an old period.
    await endPeriodAction(fd({}));
    db.prepare(`UPDATE cycles SET period_end = ? WHERE profile_id = ?`).run(
      shiftDateStr(today(profileId), -30),
      profileId
    );
    const old = await reopenPeriodAction(fd({}));
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.error).toMatch(/edit its end date/);
    expect(getOpenPeriod(profileId)).toBeNull();
  });

  it("'Still bleeding' with nothing ever closed reports it", async () => {
    const none = await reopenPeriodAction(fd({}));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/No recently ended period/);
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

  it("refuses a future start and a future end (#1682 fix c)", async () => {
    const future = shiftDateStr(today(profileId), 1);
    const bad = await saveCycleAction(fd({ period_start: future }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/can't start in the future/);

    const badEnd = await saveCycleAction(
      fd({
        period_start: shiftDateStr(today(profileId), -2),
        period_end: future,
      })
    );
    expect(badEnd.ok).toBe(false);
    if (!badEnd.ok) expect(badEnd.error).toMatch(/can't end in the future/);
    expect(listCyclePeriods(profileId).length).toBe(0);
  });

  it("allows arbitrarily old backfill (#1682 fix c — past is unbounded)", async () => {
    const old = await saveCycleAction(
      fd({ period_start: "2011-06-01", period_end: "2011-06-05" })
    );
    expect(old.ok).toBe(true);
  });

  it("refuses an overlapping period, naming the conflict (#1682 fix d)", async () => {
    const first = await saveCycleAction(
      fd({ period_start: "2026-01-01", period_end: "2026-01-10" })
    );
    if (!first.ok) throw new Error("setup failed");

    const overlap = await saveCycleAction(
      fd({ period_start: "2026-01-05", period_end: "2026-01-08" })
    );
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) {
      expect(overlap.error).toMatch(/already recorded 2026-01-01 – 2026-01-10/);
    }
    expect(listCyclePeriods(profileId).length).toBe(1);

    // Touching but not overlapping is fine — the day after the first one ends.
    expect(
      (
        await saveCycleAction(
          fd({ period_start: "2026-01-11", period_end: "2026-01-15" })
        )
      ).ok
    ).toBe(true);
  });

  it("refuses a SECOND open period from the form (#1682 fix d)", async () => {
    await startPeriodAction(fd({}));
    const second = await saveCycleAction(
      fd({ period_start: shiftDateStr(today(profileId), -40) })
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already open/);
    expect(
      listCyclePeriods(profileId).filter((r) => r.period_end == null).length
    ).toBe(1);
  });

  it("refuses an EDIT that reorders a row into an overlap", async () => {
    const a = await saveCycleAction(
      fd({ period_start: "2026-01-01", period_end: "2026-01-10" })
    );
    const b = await saveCycleAction(
      fd({ period_start: "2026-02-01", period_end: "2026-02-05" })
    );
    if (!a.ok || !b.ok) throw new Error("setup failed");

    // Re-saving unchanged is never a conflict with itself.
    expect(
      (
        await saveCycleAction(
          fd({ id: b.id, period_start: "2026-02-01", period_end: "2026-02-05" })
        )
      ).ok
    ).toBe(true);

    const moved = await saveCycleAction(
      fd({ id: b.id, period_start: "2026-01-08", period_end: "2026-02-05" })
    );
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error).toMatch(/already recorded/);
    expect(getCycleRow(profileId, b.id)!.period_start).toBe("2026-02-01");
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
