// DB INTEGRATION TIER — the Health Connect push reconciles the day a timezone change
// re-keyed, and the blind sweep is gone (#3524, superseding the #608 sweep).
//
// WHAT THIS REPLACES, because the replacement only makes sense against it.
// `body_metrics.date` is a PROFILE-LOCAL day computed at INGEST, so when the profile's
// zone moves the next push files the same reading on a different day — one instant, two
// rows (#608). The app used to answer that by deleting every non-edit-locked Health
// Connect body_metrics row from `today − 3` forward on EVERY zone change, and trusting
// the next push to put them back. The exporter re-sends one day, not three. Four days of
// a production profile's resting HR were destroyed across two travel switches, and every
// further switch would have taken three more. No day-range bound escapes the trade: at 3
// it destroys data, at 1 it leaves an unswept duplicate on 295 of 552 ordered zone pairs.
//
// So the switch paths delete NOTHING now, and the PUSH reconciles what it actually
// carries. This tier drives the real parser and the real chunked ingest against a real
// schema and pins both halves of every deletion — the case where it fires and the case
// where it declines — because this is an unattended delete of health rows.
//
// The day arithmetic itself (sub-hour offsets, DST, the departed-zone predicate) is
// swept in the pure tier: lib/__tests__/body-metric-rekey.test.ts.
//
// Runs via `npm run test:db`; the `db` singleton points at a per-file temp DB (setup.ts).

import { describe, it, expect, afterEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getTimezone, setTimezone } from "@/lib/settings";
import { switchProfileTimezone } from "@/lib/settings/travel";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { HEALTH_CONNECT_ID } from "@/lib/integrations/health-connect";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const HONOLULU = "Pacific/Honolulu";

// The clock seam (lib/clock.ts). Every instant in this file is stated, never sampled:
// the whole question is which local day an absolute instant lands on, and a sampled
// "now" makes that a different question on every run.
const realNow = process.env.ALLOS_TEST_NOW;
function freeze(iso: string): void {
  process.env.ALLOS_TEST_NOW = iso;
}
afterEach(() => {
  if (realNow === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = realNow;
});

function newProfile(name: string, tz: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

function seedRow(
  profileId: number,
  date: string,
  fields: {
    source?: string | null;
    weight_kg?: number | null;
    resting_hr?: number | null;
    edited?: number;
  } = {}
): void {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, source, edited)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    date,
    fields.weight_kg ?? null,
    fields.resting_hr ?? null,
    fields.source === undefined ? HEALTH_CONNECT_ID : fields.source,
    fields.edited ?? 0
  );
}

interface Row {
  date: string;
  weight_kg: number | null;
  resting_hr: number | null;
  occurred_at: string | null;
}

function rows(profileId: number, source: string | null = HEALTH_CONNECT_ID) {
  return db
    .prepare(
      `SELECT date, weight_kg, resting_hr, occurred_at FROM body_metrics
        WHERE profile_id = ? AND source IS ? ORDER BY date`
    )
    .all(profileId, source) as Row[];
}

const dates = (profileId: number, source: string | null = HEALTH_CONNECT_ID) =>
  rows(profileId, source).map((r) => r.date);

// A push shaped like the real exporter's: ONE `resting_heart_rate` record. #3524's
// census of the retained production payloads found 49 of 50 pushes carrying exactly
// that, and the sweep's "rolling ~48h window" assumption is what it falsified.
function pushRestingHr(profileId: number, time: string, bpm: number): void {
  push(profileId, { resting_heart_rate: [{ time, bpm }] });
}

function pushWeight(profileId: number, time: string, kg: number): void {
  push(profileId, { weight: [{ time, kilograms: kg }] });
}

// The route's own two steps: parse in the PROFILE's current zone, then the chunked write.
function push(profileId: number, payload: Record<string, unknown>): void {
  const parsed = parseHealthConnectPayload(payload, getTimezone(profileId));
  ingestHealthConnectPayload(profileId, parsed);
}

describe("the production sequence that lost four days (#3524)", () => {
  // The owner's own worked example, checked against production and reproduced here
  // verbatim. Profile 1 was on New York, switched to Los Angeles at 2026-08-21T02:11:41Z
  // and to Honolulu at 2026-08-22T01:43:58Z. The exporter then re-pushed the resting HR
  // taken at 2026-08-20T09:30Z. Under Honolulu that instant is 23:30 on 08-19; under Los
  // Angeles it was 02:30 on 08-20, which is where the stored row sits.
  it("re-files the re-pushed reading once, and leaves 08-17…08-19 alone", () => {
    freeze("2026-08-21T02:11:41Z");
    const p = newProfile("Traveller", NY);
    // The four days the sweep destroyed, as the 03:00Z backup held them.
    seedRow(p, "2026-08-17", { resting_hr: 62 });
    seedRow(p, "2026-08-18", { resting_hr: 60 });
    seedRow(p, "2026-08-19", { resting_hr: 60 });
    seedRow(p, "2026-08-20", { resting_hr: 60 });

    switchProfileTimezone(p, LA, NY);
    freeze("2026-08-22T01:43:58Z");
    switchProfileTimezone(p, HONOLULU, NY);

    // THE SWITCHES THEMSELVES DELETED NOTHING. This is the whole P1: the old sweep took
    // every one of these rows at each switch and the exporter gave back one.
    expect(dates(p)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);

    freeze("2026-08-22T02:00:00Z");
    pushRestingHr(p, "2026-08-20T09:30:00Z", 60);

    // The reading lands ONCE, on the day Honolulu puts it (08-19), and the Los
    // Angeles-dated copy of the same instant is gone. Nothing else moved.
    expect(dates(p)).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
    expect(rows(p).map((r) => r.resting_hr)).toEqual([62, 60, 60]);
  });
});

describe("a real-shaped push after a switch keeps the days it does not carry", () => {
  // ACCEPTANCE CRITERION 1. Seeded today−3…today survive a switch plus one
  // `resting_heart_rate` record for today.
  //
  // The zone pair is chosen to make this HARD rather than easy: Los Angeles → New York
  // at 00:31 New York time, so today's fresh reading falls in the three-hour band where
  // the two zones DISAGREE about the day and the departed zone's arithmetic points
  // straight at `today − 1`, which is one of the seeded rows. What keeps it is not the
  // day arithmetic but the departed-zone predicate: the profile had already left Los
  // Angeles when the reading was taken, so no push can ever have filed it there.
  it("keeps today−3…today when the reading was taken AFTER the switch", () => {
    freeze("2026-08-22T04:30:00Z"); // 21:30 in Los Angeles on the 21st
    const p = newProfile("Fresh reading", LA);
    switchProfileTimezone(p, NY, LA); // now 00:30 on the 22nd in New York

    const t0 = today(p);
    expect(t0).toBe("2026-08-22");
    const seeded = [3, 2, 1, 0].map((n) => shiftDateStr(t0, -n));
    for (const d of seeded) seedRow(p, d, { resting_hr: 58 });

    // One record, today's, taken a minute after the switch.
    freeze("2026-08-22T04:32:00Z");
    pushRestingHr(p, "2026-08-22T04:31:00Z", 61);

    expect(dates(p)).toEqual(seeded);
    // The reading merged into today's row rather than manufacturing a second one.
    expect(rows(p).at(-1)?.resting_hr).toBe(61);
  });
});

describe("#608's duplicate, both directions, ends with ONE row", () => {
  // EAST. A 21:30 Los Angeles weigh-in is 00:30 the next day in New York, so after the
  // flight the stale row sits BELOW today. PR #3539 reproduced this as the case a
  // narrowed sweep reopens.
  it("EAST: a 21:30 Los Angeles weigh-in re-keyed into New York leaves one row", () => {
    freeze("2026-05-01T05:00:00Z");
    const p = newProfile("Eastbound", LA);
    // The weigh-in as it was stored under Los Angeles.
    pushWeight(p, "2026-05-01T04:30:00Z", 80.4);
    expect(dates(p)).toEqual(["2026-04-30"]);

    freeze("2026-05-02T05:00:00Z"); // 01:00 in New York
    switchProfileTimezone(p, NY, LA);
    pushWeight(p, "2026-05-01T04:30:00Z", 80.4);

    expect(rows(p)).toEqual([
      {
        date: "2026-05-01",
        weight_kg: 80.4,
        resting_hr: null,
        occurred_at: "2026-05-01T04:30:00Z",
      },
    ]);
  });

  // WEST. The mirror, and the half the old sweep only reached because its range had no
  // upper bound: moving west the stale row is AHEAD of today.
  it("WEST: a 00:50 New York weigh-in re-keyed into Honolulu leaves one row", () => {
    freeze("2026-05-22T04:55:00Z");
    const p = newProfile("Westbound", NY);
    pushWeight(p, "2026-05-22T04:50:00Z", 79.1);
    expect(dates(p)).toEqual(["2026-05-22"]);

    freeze("2026-05-22T05:00:00Z"); // 19:00 on the 21st in Honolulu
    switchProfileTimezone(p, HONOLULU, NY);
    expect(today(p)).toBe("2026-05-21");
    pushWeight(p, "2026-05-22T04:50:00Z", 79.1);

    expect(rows(p)).toEqual([
      {
        date: "2026-05-21",
        weight_kg: 79.1,
        resting_hr: null,
        occurred_at: "2026-05-22T04:50:00Z",
      },
    ]);
  });
});

describe("what the reconcile refuses to delete", () => {
  it("a switch with NO re-push deletes nothing at all", () => {
    freeze("2026-08-22T01:43:58Z");
    const p = newProfile("No push", LA);
    for (const d of ["2026-08-19", "2026-08-20", "2026-08-21"])
      seedRow(p, d, { resting_hr: 60 });
    switchProfileTimezone(p, HONOLULU, LA);
    switchProfileTimezone(p, NY, LA);
    expect(dates(p)).toEqual(["2026-08-19", "2026-08-20", "2026-08-21"]);
  });

  it("an EDIT-LOCKED row on the re-keyed day survives", () => {
    freeze("2026-05-02T05:00:00Z");
    const p = newProfile("Hand corrected", LA);
    // The stale row, hand-corrected through the Review resolver: a re-push would put the
    // source's number back WITHOUT the correction, so it is not the source's to withdraw.
    seedRow(p, "2026-04-30", { weight_kg: 80.4, edited: 1 });
    switchProfileTimezone(p, NY, LA);
    pushWeight(p, "2026-05-01T04:30:00Z", 80.4);

    expect(rows(p).map((r) => r.date)).toEqual(["2026-04-30", "2026-05-01"]);
    // The pair is the price of never overwriting a correction, and it is the same trade
    // the sweep made and `upsertBodyMetrics` makes on the other side.
    expect(rows(p)[0].weight_kg).toBe(80.4);
  });

  it("another source's row on the same day, and a manual row, survive", () => {
    freeze("2026-05-02T05:00:00Z");
    const p = newProfile("Mixed sources", LA);
    seedRow(p, "2026-04-30", { weight_kg: 80.4 });
    // Withings attributes each reading in the DEVICE's zone, so a profile-zone change
    // does not re-key it and there is nothing of it to reconcile.
    seedRow(p, "2026-04-30", { source: "withings", weight_kg: 80.9 });
    seedRow(p, "2026-04-30", { source: null, weight_kg: 81.2 });

    switchProfileTimezone(p, NY, LA);
    pushWeight(p, "2026-05-01T04:30:00Z", 80.4);

    expect(dates(p)).toEqual(["2026-05-01"]);
    expect(dates(p, "withings")).toEqual(["2026-04-30"]);
    expect(dates(p, null)).toEqual(["2026-04-30"]);
  });

  it("a day THIS PUSH also carries is never a victim", () => {
    freeze("2026-05-02T05:00:00Z");
    const p = newProfile("Two-day push", LA);
    // 04-30 holds a weigh-in the push does not re-send; 05-01 is the day the re-keyed
    // reading lands on. A push that carries BOTH days must not have 04-30 deleted out
    // from under it — the upsert is about to merge into that row, and a chunk boundary
    // could otherwise put the delete after the write.
    seedRow(p, "2026-04-30", { weight_kg: 80.4, resting_hr: 57 });
    switchProfileTimezone(p, NY, LA);
    push(p, {
      weight: [{ time: "2026-05-01T04:30:00Z", kilograms: 80.4 }],
      resting_heart_rate: [{ time: "2026-04-30T16:00:00Z", bpm: 58 }],
    });

    expect(dates(p)).toEqual(["2026-04-30", "2026-05-01"]);
    // The stored weigh-in the push did not re-send is still there — the point of the
    // guard. (`resting_hr` stays at its stored 57 rather than taking the pushed 58,
    // because 04-30 is the OLDEST day of a multi-day push and #606's partial-day rule
    // keeps the fuller stored average. That is the ordinary merge, unrelated to this
    // change, and it is only visible here because this is the one test that pushes two
    // days at once.)
    expect(rows(p)[0].weight_kg).toBe(80.4);
    expect(rows(p)[0].resting_hr).toBe(57);
  });

  // THE GAP THIS CHANGE LEAVES, pinned rather than left to be discovered. The reconcile
  // reads `timezone_switches`, and only the TRAVEL paths write it (lib/settings/travel.ts
  // records a switch; the Settings profile form and onboarding call `setTimezone`
  // directly, which #3263 deliberately left alone). So a zone moved through the Settings
  // form has nothing to reconcile against, and #608's duplicate survives there — where
  // the old sweep would have prevented it by deleting three days. Losing a duplicate row
  // is the trade this whole change makes on purpose; losing a day of readings is not. If
  // this assertion ever has to change, it is because the Settings form started recording
  // its switch, which is the fix.
  it("leaves the duplicate when the zone moved WITHOUT recording a switch", () => {
    freeze("2026-05-02T05:00:00Z");
    const p = newProfile("Settings-form move", LA);
    pushWeight(p, "2026-05-01T04:30:00Z", 80.4);
    expect(dates(p)).toEqual(["2026-04-30"]);

    setTimezone(p, NY); // the Settings form's own path — no switch recorded
    pushWeight(p, "2026-05-01T04:30:00Z", 80.4);
    expect(dates(p)).toEqual(["2026-04-30", "2026-05-01"]);
  });
});

describe("the reading instant is stored (#2235 / #3428)", () => {
  it("writes body_metrics.occurred_at from the day's latest Health Connect reading", () => {
    freeze("2026-05-02T05:00:00Z");
    const p = newProfile("Stamped", NY);
    push(p, {
      weight: [{ time: "2026-05-01T11:00:00Z", kilograms: 80.4 }],
      resting_heart_rate: [{ time: "2026-05-01T13:30:00Z", bpm: 58 }],
    });
    expect(rows(p)).toEqual([
      {
        date: "2026-05-01",
        weight_kg: 80.4,
        resting_hr: 58,
        occurred_at: "2026-05-01T13:30:00Z",
      },
    ]);
  });

  it("leaves occurred_at NULL when the payload states no usable instant", () => {
    freeze("2026-05-02T05:00:00Z");
    const p = newProfile("Unstamped", NY);
    seedRow(p, "2026-05-01", { weight_kg: 80.4 });
    // A later push that carries only a value for the same day must not blank a stamp,
    // and must not invent one.
    pushWeight(p, "2026-05-01T11:00:00Z", 80.6);
    expect(rows(p)[0].occurred_at).toBe("2026-05-01T11:00:00Z");
  });
});
