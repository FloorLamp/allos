// PURE TIER — the row-level time question (issue #2205 phase 3, lib/row-instants.ts).
//
// The issue's own test list asks for `eventInstant`/`recordInstant` over each of the
// five semantic patterns' row shapes, "including the null-event cases". Those are the
// interesting ones: a food serving nobody stated an eating time for, and a quick-path
// practice tick with no clock. Both must come back as an explicit absence, because the
// alternative — quietly answering with the record instant — is what turns a
// distribution of eating times into a distribution of tapping times.

import { describe, expect, it } from "vitest";
import {
  bestKnownInstant,
  eventInstant,
  instantDate,
  recordInstant,
  resolveInstant,
  rowLocalDay,
} from "@/lib/row-instants";
import { timeColumn } from "@/lib/time-columns";

const NY = "America/New_York";

describe("pattern 1 — the event/record pair", () => {
  // intake_item_logs is the pattern's harder half after the owner's #2205 ruling:
  // `given_at` is INFERRED from the tap, so it is a RECORD instant, and `taken_at` is
  // the row's insert stamp behind it. The dozen hand-rolled
  // `COALESCE(given_at, taken_at)` readers were falling WITHIN one question, not
  // substituting a record instant for an event one. Phase 2 wave 1 (migration 165)
  // added the event column this chain never had: a nullable `occurred_at`, filled only
  // when somebody states a time.
  const dose = {
    date: "2026-03-10",
    occurred_at: null,
    given_at: "2026-03-10 13:05:00",
    taken_at: "2026-03-10 18:40:00",
  };

  it("says nobody stated when an untimed dose confirm happened", () => {
    // UPDATED DELIBERATELY by #2237: before migration 165 this answered
    // `not-declared` — the schema could not answer for any row, ever. Now it answers
    // `not-recorded`, which is a different and more actionable fact: the column exists
    // and this row's is NULL. What has NOT changed is the refusal itself — handing
    // back the tap stamp is exactly the substitution #2205 exists to prevent.
    expect(eventInstant("intake_item_logs", dose)).toEqual({
      known: false,
      why: "not-recorded",
      column: "occurred_at",
    });
  });

  it("reads the event instant once somebody states one", () => {
    expect(
      eventInstant("intake_item_logs", {
        ...dose,
        occurred_at: "2026-03-10T12:30:00Z",
      })
    ).toEqual({
      known: true,
      at: "2026-03-10T12:30:00Z",
      column: "occurred_at",
      derived: false,
    });
  });

  it("reads the record instant from the more precise link of the chain", () => {
    // given_at first: an offline replay carries the client's real tap instant into it,
    // while taken_at is only when the row reached the database.
    expect(recordInstant("intake_item_logs", dose)).toEqual({
      known: true,
      at: "2026-03-10T13:05:00Z",
      column: "given_at",
      derived: false,
    });
  });

  it("falls through the record chain for a row written before given_at existed", () => {
    expect(
      recordInstant("intake_item_logs", { ...dose, given_at: null })
    ).toEqual({
      known: true,
      at: "2026-03-10T18:40:00Z",
      column: "taken_at",
      derived: false,
    });
  });

  it("normalizes a bare stored value to the canonical shape", () => {
    // The caller never learns which convention the column is on — that is what makes
    // it immune to a later conversion migration as well as to phase 2's renames.
    const r = recordInstant("intake_item_logs", dose);
    expect(r.known && r.at.endsWith("Z")).toBe(true);
  });

  it("labels the dose's best-known instant as a record answer", () => {
    expect(bestKnownInstant("intake_item_logs", dose)).toEqual({
      known: true,
      at: "2026-03-10T13:05:00Z",
      column: "given_at",
      semantic: "record",
      derived: false,
    });
  });

  // food_log_events solved the same problem OPPOSITELY: it REFUSES to infer an eating
  // time and leaves `eaten_at` null. This is the null-event case the issue names.
  it("food's undeclared eaten_at is an absence, never the log stamp", () => {
    const backfilled = {
      date: "2026-03-10",
      eaten_at: null,
      logged_at: "2026-03-10T18:00:00Z",
      time_source: null,
    };
    expect(eventInstant("food_log_events", backfilled)).toEqual({
      known: false,
      why: "not-recorded",
      column: "eaten_at",
    });
    // The record instant is still perfectly readable — the point is that it is not
    // handed back as an answer to the other question.
    expect(recordInstant("food_log_events", backfilled)).toMatchObject({
      known: true,
      at: "2026-03-10T18:00:00Z",
    });
    expect(bestKnownInstant("food_log_events", backfilled)).toMatchObject({
      known: true,
      semantic: "record",
    });
  });

  it("a stated eating time wins over the log stamp", () => {
    const stated = {
      date: "2026-03-10",
      eaten_at: "2026-03-10T12:50:00Z",
      logged_at: "2026-03-10T18:00:00Z",
      time_source: "stated",
    };
    expect(eventInstant("food_log_events", stated)).toMatchObject({
      at: "2026-03-10T12:50:00Z",
      column: "eaten_at",
    });
    expect(bestKnownInstant("food_log_events", stated)).toMatchObject({
      semantic: "event",
    });
  });
});

describe("pattern 2 — record-only", () => {
  it("has no event instant for any row, ever", () => {
    const drink = {
      date: "2026-03-10",
      logged_at: "2026-03-10T23:10:00Z",
      created_at: "2026-03-10 23:10:00",
    };
    // Not "this row is missing one" — the schema records when a drink was LOGGED and
    // nothing about when it was drunk.
    expect(eventInstant("substance_log", drink)).toEqual({
      known: false,
      why: "not-declared",
      column: null,
    });
    expect(recordInstant("substance_log", drink)).toMatchObject({
      at: "2026-03-10T23:10:00Z",
      column: "logged_at",
    });
    expect(bestKnownInstant("substance_log", drink)).toMatchObject({
      semantic: "record",
    });
  });

  it("reports the record's absence when the table has no event column at all", () => {
    expect(bestKnownInstant("substance_log", { logged_at: null })).toEqual({
      known: false,
      why: "not-recorded",
      column: "logged_at",
    });
  });

  it("reads a ledger's own stamp", () => {
    expect(
      recordInstant("audit_events", { ts: "2026-03-10 07:00:00" })
    ).toMatchObject({
      at: "2026-03-10T07:00:00Z",
      column: "ts",
    });
  });
});

describe("pattern 3 — a single optional event time", () => {
  // practice_logs.time is a profile-local HH:MM, and the quick path writes none.
  it("resolves a wall clock against the row's own day and the profile zone", () => {
    const row = { date: "2026-03-10", time: "07:30" };
    // 2026-03-10 is inside US DST (it starts March 8), so 07:30 in New York is 11:30Z.
    expect(eventInstant("practice_logs", row, NY)).toEqual({
      known: true,
      at: "2026-03-10T11:30:00Z",
      column: "time",
      // Flagged, because this instant moves if the profile's timezone changes.
      derived: true,
    });
  });

  it("refuses rather than guessing UTC when no zone is supplied", () => {
    expect(
      eventInstant("practice_logs", { date: "2026-03-10", time: "07:30" })
    ).toEqual({
      known: false,
      why: "needs-zone",
      column: "time",
    });
  });

  it("practice's null time is an absence, not the created_at stamp", () => {
    const quick = {
      date: "2026-03-10",
      time: null,
      created_at: "2026-03-10 22:15:00",
    };
    expect(eventInstant("practice_logs", quick, NY)).toEqual({
      known: false,
      why: "not-recorded",
      column: "time",
    });
    expect(bestKnownInstant("practice_logs", quick, NY)).toMatchObject({
      known: true,
      semantic: "record",
      column: "created_at",
    });
  });

  it("refuses a malformed wall clock", () => {
    expect(
      eventInstant(
        "practice_logs",
        { date: "2026-03-10", time: "half seven" },
        NY
      )
    ).toMatchObject({ known: false, why: "unreadable" });
  });
});

describe("pattern 4 — windows", () => {
  it("a window is not an event instant", () => {
    // activities/metric_samples declare start/end, not event/record-of-the-subject, so
    // asking the event question of them is answered rather than approximated.
    expect(
      eventInstant("metric_samples", { start_time: "2026-03-10T11:00:00Z" })
    ).toEqual({ known: false, why: "not-declared", column: null });
  });

  it("refuses a mixed-grain column instead of picking a shape", () => {
    const col = timeColumn("appointments", "planned")!;
    expect(col.grain).toBe("mixed");
    expect(resolveInstant(col, { scheduled_at: "2026-03-10" })).toEqual({
      known: false,
      why: "ambiguous",
      column: "scheduled_at",
    });
  });

  it("refuses a day-grained column rather than inventing a midnight", () => {
    // illness_episodes.started_at is a DAY despite its name, and ended_at is exclusive.
    const col = timeColumn("illness_episodes", "window-start")!;
    expect(col.grain).toBe("day");
    expect(resolveInstant(col, { started_at: "2026-03-01" })).toEqual({
      known: false,
      why: "day-only",
      column: "started_at",
    });
  });
});

describe("pattern 5 — day-only", () => {
  it("has neither instant, and its day is the stored one", () => {
    const weighIn = { date: "2026-03-10" };
    expect(eventInstant("body_metrics", weighIn).known).toBe(false);
    expect(recordInstant("body_metrics", weighIn).known).toBe(false);
    expect(rowLocalDay("body_metrics", weighIn, NY)).toEqual({
      known: true,
      date: "2026-03-10",
      from: "stored",
      column: "date",
    });
  });
});

describe("the local-datetime grain", () => {
  it("resolves a zoneless provider hour against a supplied zone", () => {
    const hour = {
      hour_ts: "2026-03-10T14:00",
      fetched_at: "2026-03-10 14:05:00",
    };
    expect(eventInstant("weather_uv_hours", hour, "UTC")).toEqual({
      known: true,
      at: "2026-03-10T14:00:00Z",
      column: "hour_ts",
      derived: true,
    });
    expect(eventInstant("weather_uv_hours", hour)).toMatchObject({
      why: "needs-zone",
    });
  });
});

describe("rowLocalDay", () => {
  it("prefers the stored day over one derived from the event instant", () => {
    // A user-owned day attribution is a decision the app already made (#94). Here the
    // eating instant lands on the 10th in New York and the row says the 9th; the row
    // wins, because re-deriving it would silently re-file the serving.
    expect(
      rowLocalDay(
        "food_log_events",
        { date: "2026-03-09", eaten_at: "2026-03-10T20:00:00Z" },
        NY
      )
    ).toEqual({
      known: true,
      date: "2026-03-09",
      from: "stored",
      column: "date",
    });
  });

  it("derives from the event instant when the table declares no day", () => {
    // hr_minutes carries an instant and nothing else since migration 164; 03:30Z is
    // the previous evening in New York, which is the whole point of read-time
    // attribution.
    expect(
      rowLocalDay("hr_minutes", { ts: "2026-03-10T03:30:00Z" }, NY)
    ).toEqual({
      known: true,
      date: "2026-03-09",
      from: "derived",
      column: "ts",
    });
  });

  it("never derives a day from a record instant", () => {
    // integration_sync_rows has a record stamp and no day and no event. "When was this
    // typed" is not an answer to "which day does it count for".
    expect(
      rowLocalDay(
        "integration_sync_rows",
        { created_at: "2026-03-10T03:30:00Z" },
        NY
      )
    ).toEqual({ known: false, why: "not-declared", column: null });
  });
});

describe("instantDate", () => {
  it("re-reads a resolved instant, and stays null for an absence", () => {
    const r = recordInstant("intake_item_logs", {
      given_at: "2026-03-10 13:05:00",
    });
    expect(instantDate(r)?.toISOString()).toBe("2026-03-10T13:05:00.000Z");
    expect(
      instantDate(eventInstant("body_metrics", { date: "2026-03-10" }))
    ).toBeNull();
  });
});

describe("value hygiene", () => {
  it("treats an empty or non-string cell as not recorded", () => {
    expect(
      recordInstant("intake_item_logs", { given_at: "   " })
    ).toMatchObject({
      why: "not-recorded",
      column: "given_at",
    });
    expect(recordInstant("intake_item_logs", { given_at: 0 })).toMatchObject({
      why: "not-recorded",
    });
    expect(recordInstant("intake_item_logs", {})).toMatchObject({
      why: "not-recorded",
    });
  });

  it("refuses an unparseable stored instant instead of returning a bad Date", () => {
    // And reports the FIRST link's refusal, not the fallback's: the caller asked about
    // given_at, so a chain that ran out has to name it.
    expect(
      recordInstant("intake_item_logs", { given_at: "not a time" })
    ).toEqual({
      known: false,
      why: "unreadable",
      column: "given_at",
    });
  });

  it("normalizes a millisecond ISO stamp that reached storage", () => {
    // notify_lifecycle.at is written with `new Date().toISOString()`; a reader must not
    // have to know that.
    expect(
      eventInstant("notify_lifecycle", { at: "2026-03-10T13:05:00.123Z" })
    ).toMatchObject({ at: "2026-03-10T13:05:00Z" });
  });
});
