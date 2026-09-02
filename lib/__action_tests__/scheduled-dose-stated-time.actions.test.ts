// SERVER-ACTION TIER — the scheduled dose's stated time (#4426). Auth is mocked
// (harness); the DB is real, which is the point: the property is a RELATIONSHIP between
// two columns of one row, and no component tier can see it.
//
// Before this change the scheduled dose was the only one-tap domain that could not say
// "I took it earlier than this tap". `restampDoseLogsCore`'s only callers are in the
// Telegram module, so a web-only profile's sole correction path was the full backfill
// form. The confirm now carries a WALL TIME, and the action anchors it on the row's own
// day in the OWNING profile's zone.
//
// The two columns say different things and must keep saying them:
//   `recorded_at` is immutable capture — when the app was told.
//   `occurred_at` is the administration the tap ASSERTS — when the dose was taken.
// A stated time moves the second and never the first.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { setDoseStatus } from "@/app/(app)/nutrition/intake-actions";
import { getTimezone } from "@/lib/settings";
import { statedInstantOnDate } from "@/lib/stated-time";
import { utcInstant } from "@/lib/date";
import { createLogin, createProfile, actAs, fd } from "./harness";

function actor(): { profileId: number; doseId: number } {
  const login = createLogin();
  const profile = createProfile("Dose time", login.id);
  actAs(login, profile);
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Levothyroxine', 1, 'medication', 'daily', 'must')`
      )
      .run(profile.id).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '50 mcg', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { profileId: profile.id, doseId };
}

function row(doseId: number, date: string) {
  return db
    .prepare(
      "SELECT status, recorded_at, occurred_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
    )
    .get(doseId, date) as
    | { status: string; recorded_at: string; occurred_at: string | null }
    | undefined;
}

describe("a scheduled dose confirm may state when it was actually taken (#4426)", () => {
  it("writes the stated instant to occurred_at and leaves recorded_at the tap", async () => {
    const { profileId, doseId } = actor();
    const date = today(profileId);

    const result = await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", from: "clear", at: "07:05" })
    );
    expect(result.ok).toBe(true);

    const log = row(doseId, date);
    // The instant the statement MEANS, derived through the same pure helper the
    // control's value is built from, in the OWNING profile's zone — never a naive
    // `${date}T07:05` string, which would read as host-UTC.
    const stated = statedInstantOnDate(date, "07:05", getTimezone(profileId));
    if (!stated) throw new Error("07:05 is a real time on this day");
    expect(log?.occurred_at).toBe(utcInstant(stated));
    // The two columns are not the same claim, and this row proves they are not the
    // same VALUE: a tap that states 07:05 was captured whenever it was captured.
    expect(log?.recorded_at).not.toBe(log?.occurred_at);
  });

  // DELIBERATE CONVERSE GUARDS: every case here is green on the tree before this
  // change too, because that tree ignored `at` entirely. They are the half that says
  // the new door cost nothing — an untouched confirm writes the row it always wrote,
  // and a statement the day cannot hold costs the STATEMENT rather than the dose.
  it.each([
    // An untouched confirm posts no field at all, and the row it writes is the row it
    // has always written: the administration is the tap.
    ["no statement", undefined, true],
    // A time that does not exist on the day (a DST spring-forward gap, or a forged
    // post) costs the STATEMENT, never the dose — the same fallback a refused offline
    // capture takes. The dose is far too important to refuse over a bad minute.
    ["a time that is not on this day", "24:61", true],
    ["a forged non-time", "not-a-time", true],
  ])("%s: occurred_at is the tap instant", async (_label, at, logged) => {
    const { profileId, doseId } = actor();
    const date = today(profileId);

    const result = await setDoseStatus(
      fd({ dose_id: doseId, status: "taken", from: "clear", at })
    );

    expect(result.ok).toBe(logged);
    const log = row(doseId, date);
    expect(log?.status).toBe("taken");
    expect(log?.occurred_at).toBe(log?.recorded_at);
  });

  // Also green on the base tree, and here for the same reason: the statement must not
  // have widened what a skip means.
  it("a skip states no administration however loudly the post claims one", async () => {
    const { profileId, doseId } = actor();
    const date = today(profileId);

    await setDoseStatus(
      fd({ dose_id: doseId, status: "skipped", from: "clear", at: "07:05" })
    );

    const log = row(doseId, date);
    expect(log?.status).toBe("skipped");
    // A skip is "I chose not to take it". There is no administration to time, so the
    // column stays NULL whatever the wire says.
    expect(log?.occurred_at).toBeNull();
  });
});
