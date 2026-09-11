// DB/ACTION TIER — which reading a stool tap landed on (#5663).
//
// The quick-log row now states what landed and offers to take it back, and BOTH of
// those need the row the write actually touched. `logStoolForm` does not re-derive it:
// the instant is `logBristolStool`'s decision — a judged stated minute (#4425) or the
// clock seam — and asking that question a second time in the action would be a second
// copy of it. It compares the day's rows either side of the write instead.
//
// WHAT ONLY THE REAL SCHEMA CAN PROVE is the distinction that decides the INVERSE. The
// natural key `(profile_id, metric, source, origin, started_at)` carries the instant,
// so restating a minute UPDATES the row already there rather than inserting one — and
// a delete would then take away a reading the tap never made. A mocked action tier
// cannot pose that; the ON CONFLICT clause is the thing under test.
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
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";

let profileId: number;
let day: string;

function tap(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return logStoolForm(fd);
}

function rows(): { id: number; started_at: string; value: number }[] {
  return db
    .prepare(
      `SELECT id, started_at, value FROM metric_samples
        WHERE profile_id = ? AND metric = ? ORDER BY started_at`
    )
    .all(profileId, BRISTOL_STOOL_METRIC) as {
    id: number;
    started_at: string;
    value: number;
  }[];
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

  it("reports the PREVIOUS type when restating a minute corrected a reading", async () => {
    const first = await tap({ type: "3", date: day, at: "07:05" });
    const second = await tap({ type: "4", date: day, at: "07:05" });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok || !first.ok) return;

    // ONE row still: the key is the instant, so the second tap moved the type of the
    // reading the first one wrote.
    expect(rows().map((r) => r.value)).toEqual([4]);
    expect(second.reading?.id).toBe(first.reading?.id);
    // …and the inverse the row may offer is the correction back to 3. Deleting here
    // would lose a movement the person logged, which is the failure this field exists
    // to prevent.
    expect(second.reading?.replacedType).toBe(3);
    expect(second.dayCount).toBe(1);
  });

  it("offers no reading when the tap changed nothing", async () => {
    await tap({ type: "3", date: day, at: "07:05" });
    const again = await tap({ type: "3", date: day, at: "07:05" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // The row is still there and still says type 3, but this tap did not make it —
    // an Undo would be reversing somebody else's earlier write.
    //
    // THE ABSENCE IS ASSERTED BESIDE THE PRESENCE, because an absence on its own is
    // the one assertion an answer that never carried the field at all would also
    // satisfy: the day is still listed, and only the "which row did I land on" half
    // is missing.
    expect(rows().map((r) => r.value)).toEqual([3]);
    expect(again.readings).toEqual([
      { id: rows()[0].id, type: 3, hhmm: "07:05" },
    ]);
    expect(again.reading).toBeUndefined();
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
    expect(outcome.readings[0].hhmm).toBe(stored[0].started_at.slice(11, 16));
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
