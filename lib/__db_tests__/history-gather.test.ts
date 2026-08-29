import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { gatherHistoryLog } from "@/lib/history";
import { mergeMemberTimelines } from "@/lib/timeline-multi";
import { HISTORY_LOG_KINDS } from "@/lib/history-format";

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
