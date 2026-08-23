import { describe, it, expect } from "vitest";
import {
  departedZones,
  rekeyedDaysFor,
  type DepartedZone,
} from "@/lib/integrations/body-metric-rekey";
import type { TimezoneSwitch } from "@/lib/travel-timezone";

// THE DAY ARITHMETIC BEHIND THE INGEST RECONCILE (#3524), on its own.
//
// The database half deletes rows, so the question "which stored day was this reading
// filed under before the profile moved" is answered here, purely, where every offset and
// every DST season is cheap to sweep. The DB tier
// (lib/__db_tests__/hc-timezone-rekey-reconcile.test.ts) then pins that a delete follows
// a candidate and that nothing follows its absence.
//
// SUB-HOUR OFFSETS AND DST ARE WHERE THIS BREAKS, so they are not an afterthought below.
// PR #3539's adversarial lens found `Pacific/Niue → Pacific/Chatham` crossing 24 hours
// ONLY in Chatham's DST — invisible at hourly sampling, and it needed 15-minute
// resolution to see. The cases here are chosen at that resolution and each names the
// wall clock it is standing on.

const at = (iso: string) => new Date(iso);
const zone = (z: string, iso: string): DepartedZone => ({
  zone: z,
  at: Date.parse(iso),
});

describe("rekeyedDaysFor: which day a departed zone filed this instant under", () => {
  // The owner's own worked example on #3524, against the production sequence that lost
  // the data. Profile 1 was on America/Los_Angeles, switched to Pacific/Honolulu at
  // 2026-08-22T01:43:58Z, and the exporter re-pushed the resting HR taken at
  // 2026-08-20T09:30Z. Under Honolulu that reading is 23:30 on 08-19; under Los Angeles
  // it was 02:30 on 08-20, which is where the row already sits.
  it("names the LA-dated 08-20 row for the 09:30Z reading Honolulu files on 08-19", () => {
    const days = rekeyedDaysFor(at("2026-08-20T09:30:00Z"), "2026-08-19", [
      zone("America/Los_Angeles", "2026-08-22T01:43:58Z"),
    ]);
    expect(days).toEqual([{ date: "2026-08-20", zone: "America/Los_Angeles" }]);
  });

  // #608's eastward evening re-key, the case PR #3539's lens reproduced: a 21:30 Los
  // Angeles weigh-in is 00:30 the next day in New York, so after the flight the stale row
  // sits BELOW today.
  it("EAST: a 21:30 Los Angeles reading names the day BELOW its New York day", () => {
    const days = rekeyedDaysFor(at("2026-05-01T04:30:00Z"), "2026-05-01", [
      zone("America/Los_Angeles", "2026-05-02T05:00:00Z"),
    ]);
    expect(days).toEqual([{ date: "2026-04-30", zone: "America/Los_Angeles" }]);
  });

  // The mirror. Moving west the stale row is AHEAD of today, which is why the old sweep's
  // `date >= cutoff` reached it only by having no upper bound at all.
  it("WEST: a 00:50 New York reading names the day ABOVE its Honolulu day", () => {
    const days = rekeyedDaysFor(at("2026-05-22T04:50:00Z"), "2026-05-21", [
      zone("America/New_York", "2026-05-22T05:00:00Z"),
    ]);
    expect(days).toEqual([{ date: "2026-05-22", zone: "America/New_York" }]);
  });

  it("names nothing when the two zones agree on the day", () => {
    // 12:00Z is midday in London and morning in New York — same calendar day in both.
    expect(
      rekeyedDaysFor(at("2026-05-22T12:00:00Z"), "2026-05-22", [
        zone("America/New_York", "2026-05-23T00:00:00Z"),
      ])
    ).toEqual([]);
  });

  it("dedupes two departed zones that filed the reading on the same day", () => {
    // Both legs of the production trip: New York and Los Angeles put 2026-08-20T09:30Z
    // on 08-20, so the row is named ONCE and deleted once.
    const days = rekeyedDaysFor(at("2026-08-20T09:30:00Z"), "2026-08-19", [
      zone("America/Los_Angeles", "2026-08-22T01:43:58Z"),
      zone("America/New_York", "2026-08-21T02:11:41Z"),
    ]);
    expect(days).toEqual([{ date: "2026-08-20", zone: "America/Los_Angeles" }]);
  });

  // CONDITION 1, and it is the one that makes "a switch plus a fresh push deletes
  // nothing" true by construction rather than by choice of zone pair.
  it("refuses a zone the profile had ALREADY LEFT when the reading was taken", () => {
    // Same arithmetic as the westward case above — Los Angeles would file this instant on
    // 08-20 — but the profile left Los Angeles BEFORE the reading happened, so no push
    // can ever have filed it there and there is nothing of it to delete.
    const departed = [zone("America/Los_Angeles", "2026-08-20T00:00:00Z")];
    expect(
      rekeyedDaysFor(at("2026-08-20T09:30:00Z"), "2026-08-19", departed)
    ).toEqual([]);
  });

  it("refuses a switch that happened at the very instant of the reading", () => {
    expect(
      rekeyedDaysFor(at("2026-08-20T09:30:00Z"), "2026-08-19", [
        zone("America/Los_Angeles", "2026-08-20T09:30:00Z"),
      ])
    ).toEqual([]);
  });

  it("returns nothing for an unusable reading instant", () => {
    expect(
      rekeyedDaysFor(new Date("not-a-date"), "2026-08-19", [
        zone("America/Los_Angeles", "2026-08-22T01:43:58Z"),
      ])
    ).toEqual([]);
  });
});

describe("rekeyedDaysFor: sub-hour offsets and DST", () => {
  // KATHMANDU (+05:45) against DHAKA (+06:00) — FIFTEEN MINUTES apart, and that is the
  // whole difference. At 18:10Z it is 23:55 in Kathmandu and 00:10 the next day in
  // Dhaka; ten minutes later both are on the new day and there is nothing to reconcile.
  // An hourly sweep of zone pairs sees neither.
  it("KATHMANDU +05:45: 23:55 there is 00:10 the next day in Dhaka", () => {
    const departed = [zone("Asia/Kathmandu", "2026-03-12T00:00:00Z")];
    expect(
      rekeyedDaysFor(at("2026-03-10T18:10:00Z"), "2026-03-11", departed)
    ).toEqual([{ date: "2026-03-10", zone: "Asia/Kathmandu" }]);
    // Ten minutes later, same pair, no re-key.
    expect(
      rekeyedDaysFor(at("2026-03-10T18:20:00Z"), "2026-03-11", departed)
    ).toEqual([]);
  });

  // CHATHAM (+12:45 standard, +13:45 in DST) against NIUE (−11:00). This is #3539's
  // finding as an assertion: the SAME instant-of-day re-keys in January and does not in
  // July, because Chatham's DST is what pushes the pair past 24 hours.
  it("CHATHAM +12:45/+13:45: the verdict flips with Chatham's DST alone", () => {
    const departed = [zone("Pacific/Chatham", "2026-08-01T00:00:00Z")];
    // January — Chatham is on +13:45, 11:10Z is 00:55 on the 16th there and 00:10 on the
    // 15th in Niue.
    expect(
      rekeyedDaysFor(at("2026-01-15T11:10:00Z"), "2026-01-15", departed)
    ).toEqual([{ date: "2026-01-16", zone: "Pacific/Chatham" }]);
    // July — Chatham is on +12:45, the same clock position is 23:55 on the 15th, and the
    // two zones agree on the day.
    expect(
      rekeyedDaysFor(at("2026-07-15T11:10:00Z"), "2026-07-15", departed)
    ).toEqual([]);
  });

  // LORD HOWE (+10:30 standard, +11:00 in DST) against SYDNEY — a THIRTY-minute offset,
  // and the day still turns over between them.
  it("LORD HOWE +10:30: 00:10 there is still 23:40 the day before in Sydney", () => {
    expect(
      rekeyedDaysFor(at("2026-06-14T13:40:00Z"), "2026-06-14", [
        zone("Australia/Lord_Howe", "2026-06-16T00:00:00Z"),
      ])
    ).toEqual([{ date: "2026-06-15", zone: "Australia/Lord_Howe" }]);
  });

  // A NORTHERN/SOUTHERN DST PAIR, where BOTH zones move and they move in OPPOSITE
  // seasons. 11:30Z is 06:30 in New York and 00:30 the next day in Auckland in January;
  // in July it is 07:30 in New York and 23:30 the SAME day in Auckland. Nothing about
  // the instant-of-day changed — only which hemisphere is on summer time.
  it("NEW YORK / AUCKLAND: opposite DST seasons flip the verdict on one instant-of-day", () => {
    expect(
      rekeyedDaysFor(at("2026-01-14T11:30:00Z"), "2026-01-14", [
        zone("Pacific/Auckland", "2026-01-20T00:00:00Z"),
      ])
    ).toEqual([{ date: "2026-01-15", zone: "Pacific/Auckland" }]);
    expect(
      rekeyedDaysFor(at("2026-07-14T11:30:00Z"), "2026-07-14", [
        zone("Pacific/Auckland", "2026-07-20T00:00:00Z"),
      ])
    ).toEqual([]);
  });
});

describe("departedZones: which zones the reconcile may consider at all", () => {
  const sw = (at: string, from: string, to: string): TimezoneSwitch => ({
    at,
    from,
    to,
  });

  it("keeps the `from` of every recorded switch, newest first", () => {
    const out = departedZones([
      sw("2026-08-21T02:11:41Z", "America/New_York", "America/Los_Angeles"),
      sw("2026-08-22T01:43:58Z", "America/Los_Angeles", "Pacific/Honolulu"),
    ]);
    expect(out.map((d) => d.zone)).toEqual([
      "America/Los_Angeles",
      "America/New_York",
    ]);
  });

  // THERE IS NO DAY-RANGE LOOKBACK, and this is the test that says so rather than the
  // absence of one. An earlier draft dropped switches older than three days — the old
  // `SWEEP_DAYS` number wearing a new hat. It constrained nothing that
  // `switchedAt > readingAt` does not already constrain, and the owner ruled it out
  // (#3524, 2026-08-23). An old switch stays in the list; what stops it reaching a
  // recent reading is the predicate above, which is exact.
  it("keeps a switch from months ago rather than windowing it out", () => {
    const out = departedZones([
      sw("2026-01-04T00:00:00Z", "Asia/Tokyo", "America/New_York"),
    ]);
    expect(out.map((d) => d.zone)).toEqual(["Asia/Tokyo"]);
    // …and it cannot touch a reading taken after it, which is the actual protection.
    expect(
      rekeyedDaysFor(at("2026-08-20T09:30:00Z"), "2026-08-20", out)
    ).toEqual([]);
  });

  it("drops a corrupt record rather than failing the push", () => {
    const out = departedZones([
      sw("not-an-instant", "America/New_York", "America/Los_Angeles"),
      sw("2026-08-22T01:00:00Z", "Not/AZone", "Pacific/Honolulu"),
      sw("2026-08-22T02:00:00Z", "America/Los_Angeles", "Pacific/Honolulu"),
    ]);
    expect(out.map((d) => d.zone)).toEqual(["America/Los_Angeles"]);
  });

  it("has an empty history for a profile that has never switched", () => {
    expect(departedZones([])).toEqual([]);
  });
});
