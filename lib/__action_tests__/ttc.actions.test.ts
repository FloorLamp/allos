// SERVER-ACTION TIER — trying-to-conceive actions (issue #1680).
//
// Drives the declaration + the three one-tap observation actions through the (mocked) auth
// guard against a real temp DB. Asserts the gate, the rows written into each SHIPPED
// observation store, and the typed refusals — a handler must never confirm a write that
// did not happen.

import { beforeEach, describe, expect, it } from "vitest";
import {
  logBbtAction,
  logLhTestAction,
  logMucusAction,
  setTtcStartAction,
} from "@/app/(app)/medical/cycles/ttc-actions";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getTtcStart } from "@/lib/settings";
import { mucusOrdinal } from "@/lib/ttc";
import {
  listBbtReadings,
  listLhTests,
  listMucusObservations,
} from "@/lib/ttc-store";
import { actAs, createLogin, createProfile, fd } from "./harness";

const ALL = "1900-01-01";

describe("ttc actions", () => {
  let profileId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("TTC Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
  });

  it("declares and clears the TTC start, refusing a future or malformed date", async () => {
    const anchor = today(profileId);
    const start = shiftDateStr(anchor, -90);
    expect(await setTtcStartAction(fd({ start }))).toEqual({ ok: true });
    expect(getTtcStart(profileId)).toBe(start);

    const future = await setTtcStartAction(
      fd({ start: shiftDateStr(anchor, 1) })
    );
    expect(future.ok).toBe(false);
    expect(getTtcStart(profileId)).toBe(start); // unchanged

    const bad = await setTtcStartAction(fd({ start: "yesterday" }));
    expect(bad.ok).toBe(false);
    expect(getTtcStart(profileId)).toBe(start);

    // Clearing stops the surfaces; the declaration is the only thing removed.
    expect(await setTtcStartAction(fd({ start: "" }))).toEqual({ ok: true });
    expect(getTtcStart(profileId)).toBeNull();
  });

  it("records an LH test into medical_records, and refuses a bad result", async () => {
    expect(await logLhTestAction(fd({ result: "positive" }))).toEqual({
      ok: true,
    });
    expect(listLhTests(profileId, ALL)).toEqual([
      { date: today(profileId), result: "positive" },
    ]);

    const bad = await logLhTestAction(fd({ result: "maybe" }));
    expect(bad.ok).toBe(false);
    expect(listLhTests(profileId, ALL)).toHaveLength(1);
  });

  it("converts an entered °C waking temperature to canonical °F", async () => {
    expect(await logBbtAction(fd({ value: "36.5", unit: "C" }))).toEqual({
      ok: true,
    });
    const [reading] = listBbtReadings(profileId, ALL);
    expect(reading.date).toBe(today(profileId));
    expect(reading.degF).toBeCloseTo(97.7, 1);
  });

  it("refuses an out-of-range temperature without writing", async () => {
    const out = await logBbtAction(fd({ value: "36.5", unit: "F" }));
    expect(out.ok).toBe(false);
    expect(listBbtReadings(profileId, ALL)).toEqual([]);
  });

  it("records a cervical-mucus observation into symptom_logs", async () => {
    expect(await logMucusAction(fd({ quality: "egg_white" }))).toEqual({
      ok: true,
    });
    expect(listMucusObservations(profileId, ALL)).toEqual([
      { date: today(profileId), quality: "egg_white" },
    ]);
    expect(mucusOrdinal("egg_white")).toBe(4);

    const bad = await logMucusAction(fd({ quality: "slippery" }));
    expect(bad.ok).toBe(false);
    expect(listMucusObservations(profileId, ALL)).toHaveLength(1);
  });

  it("logging an observation never declares TTC on the user's behalf", async () => {
    await logLhTestAction(fd({ result: "positive" }));
    await logMucusAction(fd({ quality: "creamy" }));
    await logBbtAction(fd({ value: "97.4", unit: "F" }));
    expect(getTtcStart(profileId)).toBeNull();
  });
});
