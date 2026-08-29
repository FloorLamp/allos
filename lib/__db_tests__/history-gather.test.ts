import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { gatherHistoryLog } from "@/lib/history";
import { mergeMemberTimelines } from "@/lib/timeline-multi";
import { HISTORY_LOG_KINDS } from "@/lib/history-format";
import { setLoginSetting } from "@/lib/settings";

// THE RECORD'S GATHER (#3958 phase 1). What the pure tier cannot reach: whose rows
// come back, which kinds a chip is earned by, and the two boundaries that decide what
// a reader sees — the profile scope on every read, and the record's end at now.

function profile(name: string, birthYear?: number): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (birthYear != null) {
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', ?)"
    ).run(id, `${birthYear}-04-02`);
  }
  return id;
}

function login(): number {
  return Number(
    db
      .prepare("INSERT INTO logins (username, password_hash) VALUES (?, 'x')")
      .run(`history_${Math.random().toString(36).slice(2, 8)}`).lastInsertRowid
  );
}

function serving(profileId: number, date: string, minute: number): void {
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, 'berries', ?, ?)`
  ).run(
    profileId,
    date,
    `${date}T12:${String(minute).padStart(2, "0")}:00.000Z`
  );
}

function practice(profileId: number, date: string, name: string): void {
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, time, duration_min)
     VALUES (?, ?, ?, '07:15', 20)`
  ).run(profileId, name, date);
}

function weighIn(profileId: number, date: string, kg: number): void {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
  ).run(profileId, date, kg);
}

function units(profileId: number, date: string, n: number): void {
  db.prepare(
    `INSERT INTO substance_daily_totals (profile_id, substance, date, units)
     VALUES (?, 'nicotine', ?, ?)`
  ).run(profileId, date, n);
}

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

describe("gatherHistoryLog", () => {
  it("returns only the named profile's rows, across every Logs kind", () => {
    const mine = profile("history mine");
    const theirs = profile("history theirs");
    const loginId = login();
    serving(mine, YESTERDAY, 1);
    practice(mine, YESTERDAY, "history breathwork");
    weighIn(mine, YESTERDAY, 71.5);
    units(mine, YESTERDAY, 2);
    serving(theirs, YESTERDAY, 2);
    practice(theirs, YESTERDAY, "stranger breathwork");
    weighIn(theirs, YESTERDAY, 99.9);
    units(theirs, YESTERDAY, 9);

    const gather = gatherHistoryLog(mine, { loginId, limit: 200 });
    expect(gather.rows.map((r) => r.kind).sort()).toEqual([
      "body",
      "food",
      "practice",
      "substance",
    ]);
    expect(gather.rows.every((r) => r.profileId === mine)).toBe(true);
    expect(gather.rows.map((r) => r.detail).join(" ")).not.toContain("99.9");
    // A chip is data-presence-earned: the kinds with no row never advertise.
    expect(gather.presentKinds.sort()).toEqual([
      "body",
      "food",
      "practice",
      "substance",
    ]);
    expect(HISTORY_LOG_KINDS).toContain("dose");
    expect(gather.presentKinds).not.toContain("dose");
  });

  it("ends the record at now — a future-dated row is not a record of what happened", () => {
    const p = profile("history future");
    const loginId = login();
    weighIn(p, TODAY, 70);
    weighIn(p, TOMORROW, 70.4);
    const dates = gatherHistoryLog(p, { loginId, limit: 200 }).rows.map(
      (r) => r.date
    );
    expect(dates).toContain(TODAY);
    expect(dates).not.toContain(TOMORROW);
  });

  it("narrows to one kind, one day and one item without widening the scope", () => {
    const p = profile("history filters");
    const loginId = login();
    serving(p, YESTERDAY, 1);
    serving(p, TODAY, 2);
    practice(p, TODAY, "history yoga");

    expect(
      gatherHistoryLog(p, { loginId, limit: 200, kind: "food" }).rows
    ).toHaveLength(2);
    expect(
      gatherHistoryLog(p, { loginId, limit: 200, day: TODAY })
        .rows.map((r) => r.kind)
        .sort()
    ).toEqual(["food", "practice"]);
    expect(
      gatherHistoryLog(p, {
        loginId,
        limit: 200,
        kind: "food",
        item: "berries",
      }).rows
    ).toHaveLength(2);
    expect(
      gatherHistoryLog(p, {
        loginId,
        limit: 200,
        kind: "food",
        item: "leafy_greens",
      }).rows
    ).toHaveLength(0);
  });

  // THE SUBSTANCE RECORD IS ADULT-ONLY CONTENT (#1174/#1279), and the gate is asked of
  // the SUBJECT's age. That is what makes `?view=everyone` inherit it per member
  // instead of re-deriving one verdict across a widened query — the property the issue
  // requires and the one a merged feed is most likely to lose.
  it("inherits the substance age gate per subject in a merged feed", () => {
    const loginId = login();
    const adult = profile("history adult", 1990);
    const minor = profile("history minor", new Date().getFullYear() - 11);
    units(adult, YESTERDAY, 3);
    units(minor, YESTERDAY, 4);
    serving(minor, YESTERDAY, 5);

    const feeds = [adult, minor].map((id) => ({
      profileId: id,
      today: TODAY,
      events: gatherHistoryLog(id, { loginId, limit: 200 }).rows,
    }));
    const merged = mergeMemberTimelines(feeds).flatMap((d) => d.events);
    expect(
      merged.filter((r) => r.kind === "substance").map((r) => r.profileId)
    ).toEqual([adult]);
    // The minor's other kinds are untouched — the gate is the substance record's,
    // not a blanket exclusion of the member.
    expect(merged.some((r) => r.profileId === minor && r.kind === "food")).toBe(
      true
    );
  });

  it("reports more to load when the bound cut rows off", () => {
    const p = profile("history bound");
    const loginId = login();
    for (let i = 1; i <= 6; i++) serving(p, YESTERDAY, i);
    expect(gatherHistoryLog(p, { loginId, limit: 3 }).hasMore).toBe(true);
    expect(gatherHistoryLog(p, { loginId, limit: 50 }).hasMore).toBe(false);
  });
});

// ── THE TWO CONTRACTS THE ROW OWES ITS EDITOR ────────────────────────────────
//
// Both of these shipped wrong and CI was green, because the page's tests exercised
// reading and never writing. They are asserted HERE, at the gather, because that is
// where the wrong value is made: the form downstream posts faithfully whatever the
// row hands it, so a component test alone would have agreed with the defect.

describe("the row hands its editor the value the reader is looking at", () => {
  it("prefills a weight in the DISPLAY unit it printed, not the stored kilograms", () => {
    const p = profile("history weight unit");
    const loginId = login();
    setLoginSetting(loginId, "weight_unit", "lb");
    weighIn(p, YESTERDAY, 70);

    const [row] = gatherHistoryLog(p, {
      loginId,
      limit: 200,
      kind: "body",
      item: "weight",
    }).rows;
    expect(row.edit).toMatchObject({
      kind: "body",
      slug: "weight",
      unit: "lb",
    });

    // THE WHOLE DEFECT IN ONE COMPARISON. The row printed "154.3 lb" while the editor
    // opened on the stored 70, and `updateMetricReading` was told to read that 70 AS
    // POUNDS — so saving an untouched form rewrote 70 kg to 31.75 kg. The number in
    // the detail and the number in the field are now the same value, so they cannot
    // disagree again.
    const edit = row.edit as { kind: "body"; value: number };
    expect(row.detail.startsWith(`${edit.value}`)).toBe(true);
    expect(edit.value).toBeGreaterThan(150);
    expect(edit.value).toBeLessThan(160);

    // And in the login's own unit nothing converts at all.
    const kgLogin = login();
    setLoginSetting(kgLogin, "weight_unit", "kg");
    const [kgRow] = gatherHistoryLog(p, {
      loginId: kgLogin,
      limit: 200,
      kind: "body",
      item: "weight",
    }).rows;
    expect((kgRow.edit as { value: number }).value).toBe(70);
  });

  it("hands a practice's STORED time, never the filing clock its row falls back to", () => {
    const p = profile("history practice time");
    const loginId = login();
    // A quick-path tick: no session time was ever stated, so the row's clock is the
    // record chain's and says so.
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, notes, created_at)
       VALUES (?, 'history quick tick', ?, 'evening wind-down', ?)`
    ).run(p, YESTERDAY, `${YESTERDAY}T19:43:00.000Z`);

    const [row] = gatherHistoryLog(p, {
      loginId,
      limit: 200,
      kind: "practice",
    }).rows;
    expect(row.clockKind).toBe("logged");
    expect(row.clock).toMatch(/^logged /);
    // `sortTime` is the resolved instant and is deliberately non-null — it is what
    // orders the row. What the EDITOR may post back is the column, and there is
    // nothing in it: posting `sortTime` here is what stamped 19:43 into the event
    // column while somebody corrected a duration.
    expect(row.sortTime).not.toBeNull();
    expect(row.edit).toMatchObject({ kind: "practice", statedTime: null });

    // A stated session time reaches the editor unchanged.
    practice(p, YESTERDAY, "history stated tick");
    const stated = gatherHistoryLog(p, {
      loginId,
      limit: 200,
      kind: "practice",
      item: "history stated tick",
    }).rows[0];
    expect(stated.clockKind).toBe("stated");
    expect(stated.edit).toMatchObject({ statedTime: "07:15" });
  });
});

// ── THE BOUND IS A BOUND, NOT A CEILING ──────────────────────────────────────
//
// `getFoodLedgerPage` / `getPracticeLedgerPage` clamped their page size to 100 while
// the deleted routes drove them with `?page=`. The record has no pager, so the clamp
// silently capped two of five kinds at 100 rows and left "Load more" reporting more
// forever — a year of food logging permanently unreachable on the record page.
describe("the read is bounded by the caller, not by a hidden page-size cap", () => {
  it.each([
    ["food", (p: number, i: number) => serving(p, YESTERDAY, i % 60)],
    [
      "practice",
      (p: number, i: number) => practice(p, YESTERDAY, `history bulk ${i}`),
    ],
  ] as const)(
    "returns more than 100 %s rows when asked for them",
    (kind, seed) => {
      const p = profile(`history bound ${kind}`);
      const loginId = login();
      for (let i = 0; i < 130; i += 1) seed(p, i);

      const bounded = gatherHistoryLog(p, { loginId, limit: 50, kind });
      expect(bounded.rows).toHaveLength(50);
      expect(bounded.hasMore).toBe(true);

      // The number that used to be 100 whatever was asked for.
      const widened = gatherHistoryLog(p, { loginId, limit: 200, kind });
      expect(widened.rows).toHaveLength(130);
      expect(widened.hasMore).toBe(false);
    }
  );

  it("counts RENDERED rows for body, where one stored row is up to three", () => {
    const p = profile("history body fanout");
    const loginId = login();
    for (let i = 1; i <= 4; i += 1) {
      db.prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, resting_hr)
         VALUES (?, ?, ?, ?, ?)`
      ).run(p, `2026-0${i}-0${i}`, 70 + i, 20 + i, 50 + i);
    }
    // Two STORED rows are six measures; a bound counted in stored rows would render
    // three times what every other kind renders at the same `limit`.
    const gather = gatherHistoryLog(p, { loginId, limit: 2, kind: "body" });
    expect(gather.rows).toHaveLength(2);
    expect(gather.hasMore).toBe(true);
  });
});

// ── THE CHIP ROW IS ABOUT THE PROFILE, NOT ABOUT THE VIEW ────────────────────
describe("presentKinds does not collapse when the page is filtered", () => {
  it("names every kind the profile has, whatever kind is being shown", () => {
    const p = profile("history presence");
    const loginId = login();
    serving(p, YESTERDAY, 1);
    practice(p, YESTERDAY, "history presence yoga");
    weighIn(p, YESTERDAY, 71);

    const all = gatherHistoryLog(p, {
      loginId,
      limit: 200,
    }).presentKinds.sort();
    expect(all).toEqual(["body", "food", "practice"]);
    // DERIVED FROM THE GATHER'S OWN READS this answered ["food"] here, so the chip
    // row collapsed to "All · Food" and every kind→kind move cost two taps.
    expect(
      gatherHistoryLog(p, {
        loginId,
        limit: 200,
        kind: "food",
      }).presentKinds.sort()
    ).toEqual(all);
    // Nor does narrowing to ONE DAY hide the kinds recorded on other days.
    expect(
      gatherHistoryLog(p, {
        loginId,
        limit: 200,
        day: TODAY,
      }).presentKinds.sort()
    ).toEqual(all);
  });

  it("does not offer a substance chip to a known minor", () => {
    const minor = profile(
      "history presence minor",
      new Date().getFullYear() - 11
    );
    const loginId = login();
    units(minor, YESTERDAY, 2);
    serving(minor, YESTERDAY, 1);
    const kinds = gatherHistoryLog(minor, { loginId, limit: 200 }).presentKinds;
    // A chip is an OFFER, and the record must not advertise what its gather refuses.
    expect(kinds).not.toContain("substance");
    expect(kinds).toContain("food");
  });
});
