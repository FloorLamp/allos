// DB/ACTION TIER — which reading a stool tap landed on (#5663).
//
// The quick-log row now states what landed and offers to take it back, and BOTH of
// those need the row the write actually touched. `logStoolForm` does not re-derive it:
// the instant is `logBristolStool`'s decision — a judged stated minute (#4425) or the
// clock seam — and asking that question a second time in the action would be a second
// copy of it. It compares the day's rows either side of the write instead.
//
// WHAT ONLY THE REAL SCHEMA CAN PROVE is which rows a tap makes. That used to be the
// distinction deciding the INVERSE: the samples natural key carried the instant, so
// restating a minute UPDATED the row already there and a delete would have taken away a
// reading the tap never made. #5872 moved the store to an APPEND-ONLY ledger with no
// natural key, so every tap inserts and the inverse is always a delete — and the case
// that used to assert the correction now asserts the second row, which is the movement
// the old store silently threw away.
//
// The gate is mocked because authorization is not what is being asked here — it is
// asked in `require-profile-write-access.test.ts` — and the real one needs a session.

import { describe, it, expect, beforeEach, vi } from "vitest";

const gate = vi.hoisted(() => ({ profileId: 0 }));
vi.mock("@/app/(app)/gate-item", () => ({
  gateItemProfile: async () => gate.profileId,
  gateSubjectProfile: async () => gate.profileId,
}));
vi.mock("@/lib/revalidate", () => ({ revalidateRoute: () => {} }));

import { db, today } from "@/lib/db";
import { logStoolForm } from "@/app/(app)/stool-actions";
import { getTimezone } from "@/lib/settings";
import { zonedDateParts } from "@/lib/date";

let profileId: number;
let day: string;

function tap(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return logStoolForm(fd);
}

function rows(): {
  id: number;
  occurred_at: string | null;
  recorded_at: string;
  type: number | null;
}[] {
  return db
    .prepare(
      `SELECT id, occurred_at, recorded_at, type FROM stool_events
        WHERE profile_id = ? ORDER BY COALESCE(occurred_at, recorded_at), id`
    )
    .all(profileId) as {
    id: number;
    occurred_at: string | null;
    recorded_at: string;
    type: number | null;
  }[];
}

/** The profile-local "HH:MM" the receipt prints for a row — its best-known instant. */
function shownAt(row: { occurred_at: string | null; recorded_at: string }): string {
  return zonedDateParts(
    getTimezone(profileId),
    new Date(row.occurred_at ?? row.recorded_at)
  ).hhmm;
}

beforeEach(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Receipt')").run()
      .lastInsertRowid
  );
  gate.profileId = profileId;
  day = today(profileId);
});

describe("the reading a tap landed on", () => {
  it("names the row it inserted, and the minute that row carries", async () => {
    const outcome = await tap({ type: "4", date: day, at: "07:05" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const stored = rows();
    expect(stored).toHaveLength(1);
    // The row's own address, and the day's rows as the sheet lists them — read back
    // from the store rather than echoed from the request, which is what makes a row's
    // sentence true even when the stated minute was refused (below).
    expect(outcome.reading).toEqual({ id: stored[0].id });
    expect(outcome.readings).toEqual([
      { id: stored[0].id, type: 4, hhmm: "07:05" },
    ]);
    // A fresh reading's inverse is a delete, so there is no previous type to restore.
    expect(outcome.reading?.replacedType).toBeUndefined();
  });

  // INVERTED BY #5872, and this is the case that carries the defect. It used to read
  // "reports the PREVIOUS type when restating a minute corrected a reading" and assert
  // ONE row — the second tap overwriting the first. Two movements stated at the same
  // minute are two movements.
  //
  // FALSIFIED against the unfixed tree: with `logBristolStool` still upserting onto
  // `metric_samples`, this fails with one row where two are expected.
  it("keeps a second tap at the same stated minute as its own row", async () => {
    const first = await tap({ type: "3", date: day, at: "07:05" });
    const second = await tap({ type: "4", date: day, at: "07:05" });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok || !first.ok) return;

    const stored = rows();
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.type).sort()).toEqual([3, 4]);
    // A fresh row every time, so the inverse is a delete and there is no previous type
    // to restore — the `replacedType` arm is unreachable from this door now.
    expect(second.reading?.id).not.toBe(first.reading?.id);
    expect(second.reading?.replacedType).toBeUndefined();
    expect(second.dayCount).toBe(2);
  });

  // INVERTED BY #5872. It used to read "offers no reading when the tap changed nothing"
  // — an identical re-tap upserted onto the same row and the action honestly reported
  // that it had made nothing. There is no such tap any more: an identical re-tap is a
  // second movement, gets its own row, and gets its own Undo.
  //
  // FALSIFIED against the unfixed tree: it fails there with `reading` undefined and one
  // stored row.
  it("makes a row even for an identical re-tap", async () => {
    await tap({ type: "3", date: day, at: "07:05" });
    const again = await tap({ type: "3", date: day, at: "07:05" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const stored = rows();
    expect(stored.map((r) => r.type)).toEqual([3, 3]);
    // THE PRESENCE IS ASSERTED BESIDE THE LIST, so an answer that dropped the field
    // entirely could not satisfy it: the tap names a row, and that row is one of the
    // two the day now holds.
    expect(again.reading?.id).toBeTypeOf("number");
    expect(stored.map((r) => r.id)).toContain(again.reading?.id);
    expect(again.readings).toHaveLength(2);
    expect(again.dayCount).toBe(2);
  });

  it("names the row a REFUSED stated time fell back onto, not the minute typed", async () => {
    // #4425: a refused statement costs the statement, never the observation — the
    // reading lands at the tap instant. The row must therefore say the minute it
    // actually carries, or the receipt would confirm a time nothing holds.
    // The tier freezes at 23:50 UTC (frozen-clock.ts) and the future skew is five
    // minutes, so 23:59 on this day is meaningfully ahead and the core refuses it.
    const outcome = await tap({ type: "6", date: day, at: "23:59" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.statedTimeRefused).toBe("future");
    const stored = rows();
    expect(stored).toHaveLength(1);
    // The refused statement leaves NO stated instant on the row since #5872 — the
    // honest state — so the minute the receipt prints is the tap's own, read back off
    // the row rather than echoed from the request.
    expect(stored[0].occurred_at).toBeNull();
    expect(outcome.readings[0].hhmm).toBe(shownAt(stored[0]));
    expect(outcome.readings[0].hhmm).not.toBe("23:59");
  });

  it("picks THIS tap's row out of a day that already holds several", async () => {
    for (const [type, at] of [
      ["1", "06:00"],
      ["5", "09:30"],
      ["2", "21:15"],
    ] as const)
      await tap({ type, date: day, at });
    const before = rows().map((r) => r.id);

    const outcome = await tap({ type: "7", date: day, at: "12:00" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Inserted in the MIDDLE of the day by instant, so a receipt that just took the
    // newest row would name 21:15's reading and offer to delete it.
    expect(before).not.toContain(outcome.reading?.id);
    // NEWEST FIRST is the order the sheet renders, so it is the order the action owes.
    expect(outcome.readings.map((r) => r.hhmm)).toEqual([
      "21:15",
      "12:00",
      "09:30",
      "06:00",
    ]);
    expect(
      outcome.readings.find((r) => r.id === outcome.reading?.id)?.hhmm
    ).toBe("12:00");
    expect(outcome.dayCount).toBe(4);
  });

  it("never reaches another profile's reading on the same day and minute", async () => {
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Someone else')").run()
        .lastInsertRowid
    );
    gate.profileId = other;
    const theirs = await tap({ type: "2", date: day, at: "07:05" });
    gate.profileId = profileId;
    const mine = await tap({ type: "4", date: day, at: "07:05" });
    expect(theirs.ok && mine.ok).toBe(true);
    if (!theirs.ok || !mine.ok) return;

    // Subject-scoped at every step: the rows compared either side of the write are
    // the GATED profile's, so a receipt can only ever address a row this write was
    // authorized to make.
    expect(mine.reading?.id).not.toBe(theirs.reading?.id);
    expect(mine.reading?.replacedType).toBeUndefined();
    // The LIST is the leak this guards: the sheet renders every row it is handed, so
    // one row belonging to the other profile would be printed on this person's sheet.
    expect(mine.readings.map((r) => r.id)).toEqual([mine.reading?.id]);
    expect(mine.dayCount).toBe(1);
  });
});
