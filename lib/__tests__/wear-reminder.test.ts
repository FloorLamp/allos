// The bedtime wear reminder's pure decision (#2161).
//
// The matrix that matters is not "does it fire on the off-wrist signature" — it is the
// list of things that must SILENCE it, because this is a contact INCREASE and the
// contact-consent rule only permits one behind a user-owned declaration.

import { describe, it, expect } from "vitest";
import {
  bedtimeWearBody,
  bedtimeWearVerdict,
  WEAR_QUIET_TOLERANCE_MIN,
  type BedtimeWearSignals,
} from "@/lib/wear-reminder";

// The measured incident (#2146's 56-day profile): charger at 21:05, bedtime slot at
// 22:00, the phone still pushing its own aggregates the whole time.
const OFF_WRIST: BedtimeWearSignals = {
  enabled: true,
  expectedActive: true,
  providerHealthy: true,
  minutesSinceStream: 55,
  syncedDuringGap: true,
};

describe("bedtimeWearVerdict (#2161)", () => {
  it("fires on the off-wrist signature: quiet at the slot, syncs still ok", () => {
    expect(bedtimeWearVerdict(OFF_WRIST)).toEqual({
      send: true,
      quietForMin: 55,
    });
  });

  it("is silent when the user has not opted in — off is exactly today's behaviour", () => {
    // Checked FIRST, and it wins over a signature that would otherwise fire. This is
    // the whole feature: a send that exists only because a user asked for it.
    expect(bedtimeWearVerdict({ ...OFF_WRIST, enabled: false })).toEqual({
      send: false,
      skip: "disabled",
    });
  });

  it("is silent for a profile that does not wear a device to sleep", () => {
    // The shared #2097/#2146 expected-active gate. Enabled is not enough: someone who
    // logs sleep manually has nothing to be reminded about, and a nightly question
    // about a device they don't own is how a surface teaches people to ignore it.
    expect(bedtimeWearVerdict({ ...OFF_WRIST, expectedActive: false })).toEqual(
      {
        send: false,
        skip: "not-expected-active",
      }
    );
  });

  it("yields to a failing or stale provider — a reconnect item owns that contact", () => {
    // "Still on the charger?" is false advice while the pipeline is down, and #1685's
    // one-row rule means the two must not both report one outage.
    expect(
      bedtimeWearVerdict({ ...OFF_WRIST, providerHealthy: false })
    ).toEqual({ send: false, skip: "provider-unhealthy" });
  });

  it("says nothing when the stream has never delivered anything", () => {
    expect(
      bedtimeWearVerdict({ ...OFF_WRIST, minutesSinceStream: null })
    ).toEqual({ send: false, skip: "no-stream" });
  });

  it("holds inside the declared tolerance and fires at it", () => {
    // A shower, a workout removal, a delivery hiccup — all shorter than the declared
    // window. The tolerance is DECLARED, never learned from a wear pattern.
    expect(
      bedtimeWearVerdict({
        ...OFF_WRIST,
        minutesSinceStream: WEAR_QUIET_TOLERANCE_MIN - 1,
      })
    ).toEqual({ send: false, skip: "stream-live" });
    expect(
      bedtimeWearVerdict({
        ...OFF_WRIST,
        minutesSinceStream: WEAR_QUIET_TOLERANCE_MIN,
      })
    ).toEqual({ send: true, quietForMin: WEAR_QUIET_TOLERANCE_MIN });
    // The self-corrected night: the watch went back on at 21:50, so at the slot the
    // stream is only minutes old and there is nothing to say.
    expect(
      bedtimeWearVerdict({ ...OFF_WRIST, minutesSinceStream: 10 })
    ).toEqual({ send: false, skip: "stream-live" });
  });

  it("does not fire when the provider stopped syncing during the gap", () => {
    // No ok syncs in the window is "the phone is off", which is the staleness
    // detector's case (#1685) — the clause that separates the two is load-bearing,
    // not decoration.
    expect(
      bedtimeWearVerdict({ ...OFF_WRIST, syncedDuringGap: false })
    ).toEqual({ send: false, skip: "no-ok-sync" });
  });

  it("orders its guards consent → applicability → deference → data", () => {
    // Every guard off at once still reports `disabled`: the order is contractual, so
    // a reader can never conclude that some other condition is what silenced a
    // profile that simply never asked for this.
    expect(
      bedtimeWearVerdict({
        enabled: false,
        expectedActive: false,
        providerHealthy: false,
        minutesSinceStream: null,
        syncedDuringGap: false,
      })
    ).toEqual({ send: false, skip: "disabled" });
  });
});

describe("bedtimeWearBody", () => {
  it("states what the data is doing and asks, rather than instructing", () => {
    const body = bedtimeWearBody("21:05");
    expect(body).toContain("21:05");
    expect(body).toContain("?");
    // The #2097 copy rule, applied: an observation domain carries no obligation, so
    // an imperative would be an implied *should* about a night the app cannot see the
    // reasons for.
    expect(body).not.toMatch(/\bput (it|your watch) on\b/i);
    expect(body).not.toMatch(/\byou should\b/i);
  });
});
