// THE DAY LEDGER'S DOSE READER (#3987 phase 1), at the tier that can reach it.
//
// `lib/queries/day-ledger.ts` decides the bucket a past day's row files under, the
// stated-vs-logged split, the composed tap's write minute and the medication exclusion —
// for every dose row on the page's new primary surface. Its questions are all about what
// the DATABASE holds across a schedule edit, a retirement and an amendment, so none of
// them can be asked over hand-written rows: this is the tier, and the pure suite in
// `lib/__tests__/day-ledger.test.ts` owns the grouping rules downstream of it.
//
// Five of these began as an adversarial lane's attacks on #4323 and keep their ATTACK
// names, because where a case came from is part of what it teaches. They are the
// reproductions of what they broke, unchanged except in ATTACK #5, whose quoted `FoodTab`
// expression had to be updated to the fixed one — the claim it makes is the same.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { markDoseTaken, markDoseSkipped } from "@/lib/queries";
import { pendingDayDoses } from "@/lib/queries/usual-routine";
import { getDayDoseLedger } from "@/lib/queries/day-ledger";
import * as scheduleQueries from "@/lib/queries/intake/schedule";
import { buildDayLedger, stackLabel, type LedgerStack } from "@/lib/day-ledger";
import { createLogin, createProfile, actAs } from "./harness";

const NOW_ISO = "2026-08-28T10:30:00Z";
let priorNow: string | undefined;
beforeAll(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = NOW_ISO;
});
afterAll(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function seedDose(
  profileId: number,
  name: string,
  stack: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, stack)
       VALUES (?, ?, 'supplement', 1, 'should', 'daily', ?)`
      )
      .run(profileId, name, stack).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 scoop', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const born = `${shiftDateStr(today(profileId), -30)} 09:00:00`;
  db.prepare(`UPDATE intake_items SET created_at = ? WHERE id = ?`).run(
    born,
    itemId
  );
  db.prepare(`UPDATE intake_item_doses SET created_at = ? WHERE id = ?`).run(
    born,
    doseId
  );
  return { itemId, doseId };
}

describe("ATTACK #1 — two taps of one routine in one bucket, minutes apart", () => {
  it("keeps every still-open dose on exactly one ledger row", () => {
    const login = createLogin();
    const profile = createProfile("refute-4323", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);

    const seeded = ["A", "B", "C", "D", "E", "F"].map((n) =>
      seedDose(profile.id, `Morning ${n}`, "Morning stack")
    );

    // Fully organic: only the app's own clock seam moves between the taps.
    process.env.ALLOS_TEST_NOW = "2026-08-28T07:07:10Z";
    markDoseTaken(profile.id, seeded[0].doseId, seeded[0].itemId, date, "page");
    markDoseTaken(profile.id, seeded[1].doseId, seeded[1].itemId, date, "page");
    process.env.ALLOS_TEST_NOW = "2026-08-28T10:07:20Z";
    markDoseTaken(profile.id, seeded[2].doseId, seeded[2].itemId, date, "page");
    markDoseTaken(profile.id, seeded[3].doseId, seeded[3].itemId, date, "page");

    const pending = pendingDayDoses(profile.id, date);
    const groups = buildDayLedger({
      servings: [],
      doses: getDayDoseLedger(profile.id, date),
      pending,
    });
    const morning = groups.find((g) => g.bucket === "Morning")!;
    const stacks = morning.rows.filter(
      (r): r is LedgerStack => r.kind === "stack"
    );
    console.log(
      "PENDING:",
      pending.map((p) => p.doseId)
    );
    console.log("STACK LABELS:", stacks.map(stackLabel));
    console.log(
      "OPEN PER ROW:",
      stacks.map((s) => s.open.map((o) => o.doseId))
    );
    const seen = new Map<number, number>();
    for (const s of stacks)
      for (const o of s.open) seen.set(o.doseId, (seen.get(o.doseId) ?? 0) + 1);
    for (const [doseId, n] of seen)
      expect(n, `dose ${doseId} is on ${n} ledger rows`).toBe(1);
  });
});

// ── ATTACK #2: "two doses of one routine taken hours apart never share a timestamp" ──
// The collapse key is the WRITE minute; the row's clock is the ADMINISTRATION instant.
// An amendment (#2228) moves the second without moving the first.
import { updateHistoricalDose } from "@/lib/queries/intake/adherence";

describe("ATTACK #2 — one composed write, one member's time amended", () => {
  it("does not state one clock for two doses the record says were hours apart", () => {
    const login = createLogin();
    const profile = createProfile("refute-4323-amend", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);
    const a = seedDose(profile.id, "Creatine amend", "Morning stack");
    const b = seedDose(profile.id, "Collagen amend", "Morning stack");

    // ONE composed tap at 08:07 — both members, same write minute.
    process.env.ALLOS_TEST_NOW = "2026-08-28T08:07:00Z";
    markDoseTaken(profile.id, a.doseId, a.itemId, date, "page");
    markDoseTaken(profile.id, b.doseId, b.itemId, date, "page");

    // The user corrects ONE of them through the shipped dose-history amend: it was
    // actually taken at 05:15, three hours before the other.
    const logB = db
      .prepare(`SELECT id FROM intake_item_logs WHERE dose_id = ? AND date = ?`)
      .get(b.doseId, date) as { id: number };
    const outcome = updateHistoricalDose(
      profile.id,
      b.itemId,
      logB.id,
      date,
      new Date(`${date}T05:15:00.000Z`),
      null
    );
    console.log("AMEND OUTCOME:", outcome.kind);

    const rows = getDayDoseLedger(profile.id, date);
    console.log(
      "ROW CLOCKS:",
      rows.map((r) => [r.name, r.hhmm, r.writeMinute])
    );
    const groups = buildDayLedger({ servings: [], doses: rows, pending: [] });
    const morning = groups.find((g) => g.bucket === "Morning")!;
    const stacks = morning.rows.filter(
      (r): r is LedgerStack => r.kind === "stack"
    );
    console.log(
      "STACK ROWS:",
      stacks.map((s) => [
        stackLabel(s),
        s.hhmm,
        s.written.map((d) => `${d.name}@${d.hhmm}`),
      ])
    );
    // The two doses now state 05:15 and 08:07. They must not read as one timestamped row.
    const clocks = new Set(rows.map((r) => r.hhmm));
    for (const s of stacks)
      expect(
        new Set(s.written.map((d) => d.hhmm)).size,
        `a stack row states ${s.hhmm} for doses at ${[...clocks].join(", ")}`
      ).toBe(1);
  });
});

// ── ATTACK #3: the past-day bucket of a RETIRED dose ────────────────────────────────
// `getDayDoseLedger` says it files a resolved row under "the schedule version in force
// THAT DAY (#1973), not the current row". Its schedules map unions getIntakeDoses (which
// attaches `versions`) with getRetiredDoses (which does not).
describe("ATTACK #3 — a retired dose's past-day bucket", () => {
  it("files a past day's row under the slot in force that day", () => {
    const login = createLogin();
    const profile = createProfile("refute-4323-retired", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);
    const yesterday = shiftDateStr(date, -1);
    const d = seedDose(profile.id, "Magnesium retired", "Night stack");
    // It sat in EVENING until today, when it moved to MORNING.
    db.prepare(
      `INSERT INTO intake_dose_schedule_versions (dose_id, effective_from, time_of_day)
       VALUES (?, ?, 'evening'), (?, ?, 'morning')`
    ).run(d.doseId, shiftDateStr(date, -30), d.doseId, date);
    db.prepare(
      `UPDATE intake_item_doses SET time_of_day = 'evening' WHERE id = ?`
    ).run(d.doseId);

    process.env.ALLOS_TEST_NOW = "2026-08-28T20:00:00Z";
    markDoseTaken(profile.id, d.doseId, d.itemId, yesterday, "page");
    db.prepare(
      `UPDATE intake_item_doses SET time_of_day = 'morning' WHERE id = ?`
    ).run(d.doseId);

    const live = getDayDoseLedger(profile.id, yesterday);
    console.log(
      "LIVE DOSE BUCKET:",
      live.map((r) => [r.name, r.bucket])
    );
    expect(live[0]?.bucket, "live dose, yesterday").toBe("Evening");

    // Now the schedule is edited and the dose retired — the log row survives (#2131).
    db.prepare(`UPDATE intake_item_doses SET retired = 1 WHERE id = ?`).run(
      d.doseId
    );
    const retired = getDayDoseLedger(profile.id, yesterday);
    console.log(
      "RETIRED DOSE BUCKET:",
      retired.map((r) => [r.name, r.bucket])
    );
    expect(retired[0]?.bucket, "retired dose, same yesterday").toBe("Evening");
  });
});

// ── ATTACK #4: medications on both halves ───────────────────────────────────────────
describe("ATTACK #4 — a medication dose never reaches the ledger", () => {
  it("excludes a taken medication from the resolved half", () => {
    const login = createLogin();
    const profile = createProfile("refute-4323-med", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
         VALUES (?, 'Lisinopril', 'medication', 1, 'must', 'daily')`
        )
        .run(profile.id).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '10 mg', 'morning', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    const born = `${shiftDateStr(date, -30)} 09:00:00`;
    db.prepare(`UPDATE intake_items SET created_at = ? WHERE id = ?`).run(
      born,
      itemId
    );
    db.prepare(`UPDATE intake_item_doses SET created_at = ? WHERE id = ?`).run(
      born,
      doseId
    );
    markDoseTaken(profile.id, doseId, itemId, date, "page");
    const rows = getDayDoseLedger(profile.id, date);
    console.log(
      "MED ROWS:",
      rows.map((r) => r.name)
    );
    expect(rows).toEqual([]);
  });
});

// ── ATTACK #5: "beyond the window the day still STATES what it owed" ────────────────
// DayLedger.readOnlyDoseRow exists for that, and e2e/day-ledger.spec.ts asserts the
// far side of the flip. FoodTab is what actually feeds it.
import { doseLogDays } from "@/lib/dose-log-window";

describe("ATTACK #5 — the far side of the write window", () => {
  it("still states the doses a day beyond the window owed", () => {
    const login = createLogin();
    const profile = createProfile("refute-4323-window", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);
    seedDose(profile.id, "Zinc window", "Morning stack");
    seedDose(profile.id, "Boron window", "Morning stack");

    const far = shiftDateStr(date, -3); // inside the 7-day picker, outside doseLogDays
    const writable = new Set(doseLogDays(date));
    expect(writable.has(far), "the far day is outside the write window").toBe(
      false
    );

    const owed = pendingDayDoses(profile.id, far);
    console.log(
      "PENDING ON THE FAR DAY:",
      owed.map((d) => d.name)
    );
    expect(owed.length, "the far day genuinely owed doses").toBeGreaterThan(0);

    // FoodTab's own expression, verbatim (app/(app)/nutrition/FoodTab.tsx): the pending
    // half is gathered for EVERY picker day and the window chooses only the rendering,
    // so a day beyond it still states what it owed.
    //   pending: pendingByDate.get(day.date) ?? []
    const groups = buildDayLedger({
      servings: [],
      doses: getDayDoseLedger(profile.id, far),
      pending: owed,
    });
    console.log(
      "FAR-DAY LEDGER ROWS:",
      groups.flatMap((g) => g.rows.map((r) => r.kind))
    );
    const dueRows = groups
      .flatMap((g) => g.rows)
      .filter((r) => r.kind === "due");
    expect(
      dueRows.length,
      "the day beyond the window states nothing about what it owed"
    ).toBeGreaterThan(0);
  });
});

// ── THE ROW-LEVEL TIME QUESTION, asked once (#2205/#3958) ───────────────────────────
describe("the stated-vs-logged split", () => {
  it("renders a stated administration time as stated, in the profile's zone", () => {
    const login = createLogin();
    const profile = createProfile("ledger-stated", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "America/New_York");
    const date = today(profile.id);
    const d = seedDose(profile.id, "Stated D", "Morning stack");
    process.env.ALLOS_TEST_NOW = "2026-08-28T13:40:00Z";
    markDoseTaken(profile.id, d.doseId, d.itemId, date, "page");
    // Somebody named the administration instant: 07:15 local, four hours before filing.
    db.prepare(
      `UPDATE intake_item_logs SET occurred_at = ? WHERE dose_id = ? AND date = ?`
    ).run("2026-08-28T11:15:00.000Z", d.doseId, date);

    const [row] = getDayDoseLedger(profile.id, date);
    expect(row.clockKind, "an occurred_at is a stated time").toBe("stated");
    expect(row.hhmm, "rendered in the profile's zone, not UTC").toBe("07:15");
    // The tap is immutable and stays the collapse's identity even though the clock
    // moved — and it is the STORED (UTC) minute, never the profile-local one: it is an
    // identity two rows either share or do not, not a value anybody reads.
    expect(row.writeMinute).toBe("2026-08-28T13:40");
  });

  it("falls back to the filing time and SAYS that is what it did", () => {
    const login = createLogin();
    const profile = createProfile("ledger-logged", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "America/New_York");
    const date = today(profile.id);
    const d = seedDose(profile.id, "Logged D", "Morning stack");
    process.env.ALLOS_TEST_NOW = "2026-08-28T13:40:00Z";
    markDoseTaken(profile.id, d.doseId, d.itemId, date, "page");
    db.prepare(
      `UPDATE intake_item_logs SET occurred_at = NULL WHERE dose_id = ? AND date = ?`
    ).run(d.doseId, date);

    const [row] = getDayDoseLedger(profile.id, date);
    // Not "stated": the row renders through #3958's "logged 9:40am" grammar rather than
    // a bare clock claiming an administration minute nothing in the record states.
    expect(row.clockKind).toBe("logged");
    expect(row.hhmm).toBe("09:40");
  });
});

// ── A SKIP IS A RECORDED EVENT, never hidden (#3987) ────────────────────────────────
describe("skipped rows", () => {
  it("states a skip with its stored reason", () => {
    const login = createLogin();
    const profile = createProfile("ledger-skip", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);
    const d = seedDose(profile.id, "Skipped D", "Morning stack");
    process.env.ALLOS_TEST_NOW = "2026-08-28T09:00:00Z";
    markDoseSkipped(profile.id, d.doseId, d.itemId, date, "page");
    // No app surface writes a reason today (it arrives with out-of-band writes), so it
    // is set directly — the reader's job is to carry whatever the column holds.
    db.prepare(
      `UPDATE intake_item_logs SET skip_reason = 'felt queasy' WHERE dose_id = ? AND date = ?`
    ).run(d.doseId, date);

    const [row] = getDayDoseLedger(profile.id, date);
    expect(row.status).toBe("skipped");
    expect(row.skipReason).toBe("felt queasy");
  });
});

// ── PROFILE SCOPING, the universal rule ─────────────────────────────────────────────
describe("profile scoping", () => {
  it("never reads another profile's dose on the same day", () => {
    const login = createLogin();
    const mine = createProfile("ledger-mine", login.id);
    const theirs = createProfile("ledger-theirs", login.id);
    actAs(login, theirs);
    setTimezone(theirs.id, "UTC");
    const date = today(theirs.id);
    const other = seedDose(theirs.id, "Their dose", "Morning stack");
    process.env.ALLOS_TEST_NOW = "2026-08-28T09:00:00Z";
    markDoseTaken(theirs.id, other.doseId, other.itemId, date, "page");

    actAs(login, mine);
    setTimezone(mine.id, "UTC");
    const own = seedDose(mine.id, "My dose", "Morning stack");
    markDoseTaken(mine.id, own.doseId, own.itemId, date, "page");

    expect(getDayDoseLedger(mine.id, date).map((r) => r.name)).toEqual([
      "My dose",
    ]);
  });
});

describe("FoodTab's bounded day-ledger gather (#4412)", () => {
  it("reuses one full schedule read across the seven day-ledger calls", () => {
    const login = createLogin();
    const profile = createProfile("ledger schedule reuse", login.id);
    actAs(login, profile);
    setTimezone(profile.id, "UTC");
    const date = today(profile.id);
    const dose = seedDose(profile.id, "Reuse D", "Morning stack");
    markDoseTaken(profile.id, dose.doseId, dose.itemId, date, "page");

    const expected = getDayDoseLedger(profile.id, date);
    const read = vi.spyOn(scheduleQueries, "getIntakeDosesForHistory");
    const schedules = scheduleQueries.getIntakeDosesForHistory(profile.id);
    for (let i = 0; i < 7; i += 1)
      expect(getDayDoseLedger(profile.id, date, schedules)).toEqual(expected);

    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });
});
