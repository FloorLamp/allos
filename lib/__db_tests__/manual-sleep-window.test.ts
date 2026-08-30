// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1851, the sleep half: a typed bed/wake pair fills a night the wearable
// missed. The owner's ruling is per-night resolution, which changes
// `readSleepSessions`' documented one-stream rule, so what this file mostly pins is
// the SHAPE of that change — who survives a night two sources describe, who
// survives a night only one of them does, and what a stated window costs when it
// cannot be stored.
//
// EVERY assertion here has a named mutation it goes red on; the mutation is in the
// comment above it and its measured output is quoted. That standard exists because
// the previous round's seven guards had six that passed on a reverted probe: the
// unreached space was a device stream older than the read's horizon, a
// `document:<id>` source, and whether the primary-source picker is reachable at all.
// All three are seeded below.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import {
  getSleepSessions,
  getSleepRegularity,
  getDailySleepSessionsSince,
  getEditableManualSleepDurations,
  canEditManualSleepOnDate,
  getMetricSeriesBySourceInRange,
} from "@/lib/queries";
import { applyIntent, insertVitals } from "@/lib/offline/writes";
import { buildIntent, type VitalsPayload } from "@/lib/offline/queue";
import { setTimezone } from "@/lib/settings";

// UTC-pinned so a stored instant IS the wall clock and every wake-day is
// hand-checkable. The zone-sensitive cases below set their own zone.
function makeProfile(name: string, tz = "UTC"): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

const session = (
  date: string,
  value: number,
  start: string,
  end: string
): NormMetricSample => ({
  metric: "sleep_min",
  date,
  started_at: start,
  ended_at: end,
  value,
});

// `nights` consecutive 23:00→06:00 overnights ending on `lastDay`.
function overnights(lastDay: string, nights: number): NormMetricSample[] {
  const out: NormMetricSample[] = [];
  for (let offset = nights - 1; offset >= 0; offset--) {
    const day = shiftDateStr(lastDay, -offset);
    out.push(
      session(day, 420, `${shiftDateStr(day, -1)}T23:00:00Z`, `${day}T06:00:00Z`)
    );
  }
  return out;
}

const rowsOn = (profileId: number, date: string) =>
  db
    .prepare(
      `SELECT started_at AS startedAt, ended_at AS endedAt, value, source
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND date = ?
        ORDER BY started_at`
    )
    .all(profileId, date) as {
    startedAt: string;
    endedAt: string;
    value: number;
    source: string;
  }[];

describe("a typed night fills a gap the wearable missed (#1851)", () => {
  // THE CASE THE RULING IS ABOUT. 30 ring overnights, one of which the ring never
  // recorded, and the person types it.
  //
  // MUTATION: restore the stream election — put the source filter and the newest-
  // overnight probe back in `readSleepSessions` (the shipped `origin/main` read).
  // Measured on it:
  //   expected [ { date: '2026-08-30', …(4) }, …(28) ] to have a length of 30
  //     but got 29
  // — the ring wins the profile-wide election on 29 nights, so the typed one is
  // simply not in the read. On the mirror-image profile (more typed nights than
  // device ones) the same election deletes the device's history instead; the
  // horizon table below measures that direction.
  it("returns the ring's nights AND the typed one", () => {
    const id = makeProfile("SleepFillIn");
    const wakeDay = today(id);
    const missed = shiftDateStr(wakeDay, -5);
    upsertMetricSamples(
      id,
      overnights(wakeDay, 30).filter((row) => row.date !== missed),
      "oura"
    );
    expect(
      insertVitals(id, missed, { bedTime: "23:30", wakeTime: "07:00" }, "page")
        .wrote
    ).toBe(true);

    const sessions = getSleepSessions(id);
    expect(sessions).toHaveLength(30);
    expect(sessions.filter((row) => row.source === "oura")).toHaveLength(29);
    // The typed night is one of them, with the clocks as stated.
    expect(
      sessions.find((row) => row.source === "manual")
    ).toMatchObject({
      date: missed,
      start: `${shiftDateStr(missed, -1)}T23:30:00Z`,
      end: `${missed}T07:00:00Z`,
      value: 450,
    });
    expect(getSleepRegularity(id)).not.toBeNull();
  });

  // THE CONVERSE, and the reason this is a per-WINDOW election rather than "keep
  // everything": two sources describing ONE night are a duplicate account, and
  // interleaving both into the SRI's timeline is exactly what #14 forbids.
  //
  // MUTATION: drop the `pickRowsOneSourcePerWindow` call from `readSleepSessions`
  // and return the origin-picked rows directly. Measured:
  //   expected [ { date: '2026-08-30', …(4) }, …(1) ] to have a length of 1
  //     but got 2
  // — both accounts of one night in the SRI's timeline, which is the #14 interleave.
  it("still collapses two sources' accounts of the SAME night to one", () => {
    const id = makeProfile("SleepDuplicateNight");
    const wakeDay = today(id);
    upsertMetricSamples(id, overnights(wakeDay, 1), "oura");
    upsertMetricSamples(
      id,
      [
        session(
          wakeDay,
          430,
          `${shiftDateStr(wakeDay, -1)}T22:50:00Z`,
          `${wakeDay}T06:05:00Z`
        ),
      ],
      "health-connect"
    );
    const sessions = getSleepSessions(id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("health-connect");
  });

  // THE HORIZON CASE — a device stream more than a year older than the typed nights,
  // which no test reached before and which is where finding 1 lived. A `document:<id>`
  // provenance is the second unreached shape, and it matters because it is a CLASS
  // selector: one imported sleep report is a source like any other here.
  //
  // MUTATION: restore the stream election (the shipped `origin/main` read). Measured
  // on it, for both rows of this table — the recent typed nights are the newest
  // overnight, so they elect `manual` and the older stream is deleted from the read:
  //   expected [ …(30) ] to have a length of 60
  //   expected [] to have a length of 30
  it.each([
    ["a retired wearable", "oura"],
    ["one imported sleep report", "document:7"],
  ])(
    "keeps both %s outside the window and the typed nights inside it",
    (_label, source) => {
      const id = makeProfile(`SleepStale-${source}`);
      const wakeDay = today(id);
      const longAgo = shiftDateStr(wakeDay, -400);
      upsertMetricSamples(id, overnights(longAgo, 30), source);
      for (let offset = 29; offset >= 0; offset--) {
        const day = shiftDateStr(wakeDay, -offset);
        expect(
          insertVitals(id, day, { bedTime: "23:00", wakeTime: "07:00" }, "page")
            .wrote
        ).toBe(true);
      }
      const sessions = getSleepSessions(id);
      expect(sessions).toHaveLength(60);
      expect(sessions.filter((row) => row.source === "manual")).toHaveLength(30);
      expect(sessions.filter((row) => row.source === source)).toHaveLength(30);
      expect(getSleepRegularity(id)).not.toBeNull();
    }
  );

  // FINDING 1, PINNED AS THE RESIDUAL IT IS. Per-night resolution removes the harm
  // the 90-day picker bound caused — nothing above needed the picker — but the bound
  // itself is untouched by this change, and a claim that it is fixed would be false.
  // This asserts the picker's ACTUAL reachability predicate: `SourceComparison`
  // returns null below two series, over exactly the range `sleep/page.tsx` passes.
  //
  // The second expectation is this guard's own CONTROL rather than a second claim:
  // unbounded, both sources are there to choose between. So what hides the picker is
  // the range `sleep/page.tsx` passes and nothing else — which is what makes the
  // first expectation a statement about the bound instead of about the fixture.
  it("still offers no picker for a device stream older than 90 days", () => {
    const id = makeProfile("SleepPickerOutOfRange");
    const wakeDay = today(id);
    upsertMetricSamples(id, overnights(shiftDateStr(wakeDay, -400), 30), "oura");
    insertVitals(id, wakeDay, { bedTime: "23:00", wakeTime: "07:00" }, "page");

    const pageWindow = { from: shiftDateStr(wakeDay, -89), to: wakeDay };
    const inWindow = getMetricSeriesBySourceInRange(
      id,
      "sleep_min",
      pageWindow.from,
      pageWindow.to
    );
    expect(inWindow.map((s) => s.source)).toEqual(["manual"]);
    // Which is the whole of the residual: unbounded, both sources are there to
    // choose between, so the bound is the only thing hiding the control.
    expect(
      getMetricSeriesBySourceInRange(id, "sleep_min", null, null)
        .map((s) => s.source)
        .sort()
    ).toEqual(["manual", "oura"]);
  });
});

describe("one manual row per night, and what a window costs (#1851)", () => {
  // TWO corrections, because the two halves of "one row per night" fail differently.
  // Moving the BEDTIME changes the natural key, so without the DELETE the day holds
  // two rows and `sleep_min` — which is additive — reads one night as two. Moving
  // only the WAKE clock keeps the key, so the row count is right either way and what
  // rots is the row itself.
  //
  // MUTATION A: delete `upsertManualSleep`'s DELETE statement. Measured:
  //   expected [ { …(4) }, { …(4) } ] to have a length of 1 but got 2
  // MUTATION B: drop `ended_at = excluded.ended_at` from `upsertManualSample`'s
  // ON CONFLICT. Measured:
  //   -   "endedAt": "2026-08-29T06:00:00Z"
  //   +   "endedAt": "2026-08-29T07:00:00Z"
  // — a row whose stored window says eight hours while its value says seven.
  it.each([
    ["a new bedtime", { bedTime: "22:30", wakeTime: "07:00" }, "22:30", 510],
    ["a new wake clock", { bedTime: "23:00", wakeTime: "06:00" }, "23:00", 420],
  ])("re-stating the night with %s corrects the row", (_l, second, bed, value) => {
    const id = makeProfile(`SleepOneRow-${bed}`);
    const day = shiftDateStr(today(id), -1);
    insertVitals(id, day, { bedTime: "23:00", wakeTime: "07:00" }, "page");
    insertVitals(id, day, second, "page");
    const rows = rowsOn(id, day);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      startedAt: `${shiftDateStr(day, -1)}T${bed}:00Z`,
      endedAt: `${day}T${second.wakeTime}:00Z`,
      value,
    });
  });

  // FINDING 2 — the row that stored more hours than its own window said.
  // `{bedTime:"23:00",wakeTime:"07:00"}` then `{sleepHours:"12"}` alone gave
  // `23:00→07:00` with value 720, and the Sleep log rendered "23:00 → 07:00 · 12h".
  //
  // MUTATION: drop the elapsed-vs-value check in `upsertManualSleep` (retain the
  // existing window unconditionally, as the first pass did). Measured:
  //   expected '2026-08-28T23:00:00Z' to be '2026-08-29T00:00:00'
  //   expected undefined to be 'shorter-than-stated-sleep'
  it("clears clocks a later duration contradicts, and says so", () => {
    const id = makeProfile("SleepOverlongCorrection");
    const day = shiftDateStr(today(id), -1);
    insertVitals(id, day, { bedTime: "23:00", wakeTime: "07:00" }, "page");
    const outcome = insertVitals(id, day, { sleepHours: "12" }, "page");

    const rows = rowsOn(id, day);
    expect(rows).toHaveLength(1);
    // Duration-only: the midnight point key, no clocks left to contradict it.
    expect(rows[0]).toMatchObject({
      startedAt: `${day}T00:00:00`,
      endedAt: `${day}T00:00:00`,
      value: 720,
    });
    expect(outcome).toMatchObject({
      wrote: true,
      sleepWindowRefused: "shorter-than-stated-sleep",
    });
  });

  // THE CONVERSE, in the same commit: a correction that FITS must still keep the
  // clocks, or "clears them when contradicted" is indistinguishable from "always
  // clears them" — which would silently undo the feature from the Sleep page.
  //
  // MUTATION: make `upsertManualSleep` never retain an existing window. Measured:
  //   expected '2026-08-29T00:00:00' to be '2026-08-28T23:00:00Z'
  it("keeps clocks a later duration fits inside", () => {
    const id = makeProfile("SleepFittingCorrection");
    const day = shiftDateStr(today(id), -1);
    insertVitals(id, day, { bedTime: "23:00", wakeTime: "07:00" }, "page");
    const outcome = insertVitals(id, day, { sleepHours: "7" }, "page");
    expect(rowsOn(id, day)[0]).toMatchObject({
      startedAt: `${shiftDateStr(day, -1)}T23:00:00Z`,
      endedAt: `${day}T07:00:00Z`,
      value: 420,
    });
    expect(outcome).toEqual({ wrote: true });
  });

  // FINDING 3 — the bound's fallback that did not fall back. On Antarctica/Troll the
  // 2026-10-25 shift is two hours, so a nominally 23-hour pair elapses 1500 minutes,
  // outside `sleep_min`'s 0–1440 ingest envelope. It is refused. On a day that
  // already held a window, the refusal used to leave the OLD clocks in place with a
  // value from the new statement — 1380 inside a 10-hour window, no signal.
  //
  // The second statement also says 8 hours asleep, DELIBERATELY: it makes the stored
  // value 480, which fits inside the 10-hour window already on the day. Without that
  // the value would be the nominal 1380, the rule above would clear the clocks for
  // its own reason, and this guard would go green on a tree with no refusal channel
  // at all — a red observed for the wrong cause is the failure mode this file exists
  // to avoid.
  //
  // MUTATION: in `insertVitals`, pass `{ window: resolved, refused: false }` (the
  // shape before the refusal was named). Measured:
  //   -   "endedAt": "2026-10-25T00:00:00"   +   "endedAt": "2026-10-25T08:00:00Z"
  //   -   "startedAt": "2026-10-25T00:00:00" +   "startedAt": "2026-10-24T20:00:00Z"
  //   expected { wrote: true } to match object { wrote: true, …(1) }
  // — the person's stated clocks discarded, someone else's night kept, no signal.
  it("falls back to a duration-only row when the window cannot be stored", () => {
    const id = makeProfile("SleepTrollRefusal", "Antarctica/Troll");
    insertVitals(id, "2026-10-25", { bedTime: "22:00", wakeTime: "08:00" }, "page");
    const outcome = insertVitals(
      id,
      "2026-10-25",
      { bedTime: "12:00", wakeTime: "11:00", sleepHours: "8" },
      "page"
    );
    const rows = rowsOn(id, "2026-10-25");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      startedAt: "2026-10-25T00:00:00",
      endedAt: "2026-10-25T00:00:00",
      value: 480,
    });
    expect(outcome).toMatchObject({ wrote: true, sleepWindowRefused: "unstorable" });
  });

  // THE OTHER DIRECTION of the same zone, because a refusal that fires on every
  // Troll night would be a bug wearing a fix's clothes: the spring shift SHORTENS
  // the night, so a 23-hour pair elapses 1260 and is stored.
  //
  // MUTATION on the case ABOVE, which this one is the control for: bound
  // `resolveSleepWindow` on `window.minutes` (the nominal 1380, in envelope) instead
  // of the elapsed 1500. Measured — this stays green while the refusal goes red:
  //   -   "startedAt": "2026-10-25T00:00:00" +   "startedAt": "2026-10-24T10:00:00Z"
  // MUTATION on THIS one, because a refusal that fires on every long window would
  // pass the case above for the wrong reason: add `|| minutes > 1200`. Measured:
  //   +   "sleepWindowRefused": "unstorable"   ← a storable night refused
  it("stores the window when the same zone's shift goes the other way", () => {
    const id = makeProfile("SleepTrollAccepted", "Antarctica/Troll");
    const outcome = insertVitals(
      id,
      "2026-03-29",
      { bedTime: "12:00", wakeTime: "11:00" },
      "page"
    );
    expect(outcome).toEqual({ wrote: true });
    expect(rowsOn(id, "2026-03-29")[0]).toMatchObject({ value: 1260 });
  });
});

describe("a typed night stays the person's to edit (#1851)", () => {
  // MUTATION: restore `getManualSleepEditability`'s midnight-key predicate
  // (`started_at = date || 'T00:00:00'`). Measured:
  //   expected false to be true // Object.is equality
  // — the Sleep page then answers "Synced sleep entries cannot be edited here." for
  // a night the person typed themselves.
  it("keeps a windowed manual night editable", () => {
    const id = makeProfile("SleepEditableWindow");
    const day = shiftDateStr(today(id), -1);
    insertVitals(id, day, { bedTime: "23:00", wakeTime: "07:00" }, "page");
    expect(canEditManualSleepOnDate(id, day)).toBe(true);
    expect(getEditableManualSleepDurations(id, day, day)).toEqual([
      expect.objectContaining({ date: day, value: 480 }),
    ]);
  });

  // THE CONVERSE, and the reason provenance rather than the key is the right test:
  // widening editability must not reach a synced row.
  //
  // MUTATION: drop `source = 'manual' AND origin IS NULL` from the editable flag.
  // Measured: expected true to be false // Object.is equality
  it("leaves a synced night read-only", () => {
    const id = makeProfile("SleepEditableSynced");
    const wakeDay = today(id);
    upsertMetricSamples(id, overnights(wakeDay, 1), "oura");
    expect(canEditManualSleepOnDate(id, wakeDay)).toBe(false);
    expect(getEditableManualSleepDurations(id, wakeDay, wakeDay)).toEqual([]);
  });

  // The Sleep log reads through `getDailySleepSessionsSince`, which #1851 converged
  // onto `readSleepSessions`. Both must show the typed night beside the device's.
  //
  // MUTATION: restore the stream election in `readSleepSessions`. Measured:
  //   expected [ { date: '2026-08-30', …(4) } ] to have a length of 2 but got 1
  it("shows the same nights to the log and to the SRI", () => {
    const id = makeProfile("SleepLogParity");
    const wakeDay = today(id);
    upsertMetricSamples(id, overnights(shiftDateStr(wakeDay, -1), 1), "oura");
    insertVitals(id, wakeDay, { bedTime: "23:00", wakeTime: "07:00" }, "page");
    const since = shiftDateStr(wakeDay, -7);
    expect(getDailySleepSessionsSince(id, since)).toHaveLength(2);
    expect(getSleepSessions(id)).toHaveLength(2);
  });
});

describe("a night typed offline replays as the night it was (#1851)", () => {
  // The intent carries CLOCKS, not instants — an offline device has no server to ask
  // — so the zone that interprets them is whatever the profile holds when the write
  // lands. This is the rule written down in `resolveSleepWindow`'s memo, and the two
  // rows below are the two halves of it: same stated night, two zones, two instants.
  //
  // MUTATION: drop `bedTime`/`wakeTime` from `applyIntent`'s vitals payload
  // passthrough (the queue fields are optional, so this compiles). Measured on both
  // rows: expected 'rejected' to be 'done' — the intent states nothing else, so a
  // sitting that was only a night replays as an empty payload and writes no row at
  // all. The first pass shipped this half with no db-tier coverage whatsoever.
  it.each([
    ["UTC", "2026-05-13T23:00:00Z", "2026-05-14T07:00:00Z"],
    ["Asia/Tokyo", "2026-05-13T14:00:00Z", "2026-05-13T22:00:00Z"],
  ])("resolves the stated clocks in the zone at reconnect (%s)", (tz, start, end) => {
    const id = makeProfile(`SleepReplay-${tz}`, tz);
    const intent = buildIntent(
      "vitals",
      "2026-05-14",
      {
        bedTime: "23:00",
        wakeTime: "07:00",
        sleepHours: null,
        hrv: null,
        systolic: null,
        diastolic: null,
        glucose: null,
        glucoseUnit: null,
        spo2: null,
        temperature: null,
        tempUnit: null,
      } as VitalsPayload,
      id
    );
    expect(applyIntent(id, intent).status).toBe("done");
    expect(rowsOn(id, "2026-05-14")[0]).toMatchObject({
      startedAt: start,
      endedAt: end,
      value: 480,
      source: "manual",
    });
  });

  // Two DIFFERENT idempotency keys, so `alreadyReplayed` never fires: this is a
  // second sitting, not a retried flush, and it has to converge on its own.
  //
  // MUTATION: delete `upsertManualSleep`'s DELETE statement. Measured:
  //   expected [ { …(4) }, { …(4) } ] to have a length of 1 but got 2
  it("converges to one row when a second sitting replays over the first", () => {
    const id = makeProfile("SleepReplayConverge");
    const base = {
      sleepHours: null,
      hrv: null,
      systolic: null,
      diastolic: null,
      glucose: null,
      glucoseUnit: null,
      spo2: null,
      temperature: null,
      tempUnit: null,
    };
    for (const wakeTime of ["07:00", "06:30"]) {
      const intent = buildIntent(
        "vitals",
        "2026-05-14",
        { ...base, bedTime: "23:00", wakeTime } as VitalsPayload,
        id
      );
      expect(applyIntent(id, intent).status).toBe("done");
    }
    const rows = rowsOn(id, "2026-05-14");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endedAt: "2026-05-14T06:30:00Z",
      value: 450,
    });
  });
});
