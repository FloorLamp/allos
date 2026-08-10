// The bedtime wear reminder's pure decision (#2161, rebuilt on the frontier in #2341).
//
// The matrix that matters is not "does it fire on the off-wrist signature" — it is the
// list of things that must SILENCE it, because this is a contact INCREASE and the
// contact-consent rule only permits one behind a user-owned declaration.
//
// Since #2341 the list has a new head: A WORN WATCH BEHIND A SLOW PIPELINE. The two
// cases at the bottom of this file are the ones the old predicate could not tell apart
// at any threshold, replayed as PUSH SEQUENCES through the same fold the ingest path
// applies — because the discriminator is a property of the sequence, not of a reading.

import { describe, it, expect } from "vitest";
import {
  bedtimeWearBody,
  bedtimeWearVerdict,
  type BedtimeWearSignals,
} from "@/lib/wear-reminder";
import {
  FROZEN_SYNC_EVIDENCE,
  observeFrontier,
  type StreamFrontierState,
} from "@/lib/stream-frontier";
import { reminderStream } from "@/lib/integrations/continuous-streams";

/** The floor the REGISTRY declares for the watched stream — never a local constant. */
const FLOOR = reminderStream("bedtime-wear")!.stream.reminder.frontierFloorMin;

// The measured incident (#2146's 56-day profile): charger at 21:05, bedtime slot at
// 22:00, the phone still pushing its own aggregates the whole time — and, since #2341,
// two of those pushes carrying nothing new for the stream.
const OFF_WRIST: BedtimeWearSignals = {
  enabled: true,
  expectedActive: true,
  providerHealthy: true,
  frontierAgeMin: 55,
  syncsSinceAdvance: 2,
  floorMin: FLOOR,
};

describe("bedtimeWearVerdict (#2161)", () => {
  it("fires on the off-wrist signature: frontier frozen across two pushes, past the floor", () => {
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
    expect(bedtimeWearVerdict({ ...OFF_WRIST, frontierAgeMin: null })).toEqual({
      send: false,
      skip: "no-stream",
    });
  });

  it("holds inside the declared floor and fires at it", () => {
    // The floor is a FLOOR, not the decision (#2341): a watch put down two minutes
    // before the slot is frozen across two quiet pushes and must still not be
    // announced. It is DECLARED in the registry, never learned from a wear pattern.
    expect(
      bedtimeWearVerdict({ ...OFF_WRIST, frontierAgeMin: FLOOR - 1 })
    ).toEqual({ send: false, skip: "stream-live" });
    expect(bedtimeWearVerdict({ ...OFF_WRIST, frontierAgeMin: 2 })).toEqual({
      send: false,
      skip: "stream-live",
    });
    // AT the floor, not strictly past it: asked once at a slot minute, so one more
    // minute means tomorrow.
    expect(bedtimeWearVerdict({ ...OFF_WRIST, frontierAgeMin: FLOOR })).toEqual(
      { send: true, quietForMin: FLOOR }
    );
  });

  it("does not fire while the frontier is still MOVING, however old it is", () => {
    // THE #2341 REGRESSION, at the level of the pure decision. Zero pushes since the
    // last advance means the watch is producing; the age is entirely ingest lag.
    expect(
      bedtimeWearVerdict({
        ...OFF_WRIST,
        frontierAgeMin: 61,
        syncsSinceAdvance: 0,
      })
    ).toEqual({ send: false, skip: "frontier-advanced" });
  });

  it("does not fire on ONE quiet push, or on no evidence at all", () => {
    // One push carrying nothing new is ordinary jitter — the exporter batches, and a
    // push can land between two of the device's own writes.
    expect(bedtimeWearVerdict({ ...OFF_WRIST, syncsSinceAdvance: 1 })).toEqual({
      send: false,
      skip: "no-recent-sync",
    });
    // No observation at all: a fresh deploy, or the phone stopped pushing (which is
    // #1685's connection outage, not this). Absence of evidence is not evidence.
    expect(
      bedtimeWearVerdict({ ...OFF_WRIST, syncsSinceAdvance: null })
    ).toEqual({ send: false, skip: "no-recent-sync" });
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
        frontierAgeMin: null,
        syncsSinceAdvance: null,
        floorMin: FLOOR,
      })
    ).toEqual({ send: false, skip: "disabled" });
  });
});

// ── The two cases that must come apart (#2341) ────────────────────────────────
//
// Replayed as SEQUENCES OF PUSHES through `observeFrontier` — the same fold the ingest
// path applies — because "did the frontier move" cannot be expressed as a reading. Both
// nights run the same pipeline, at the same lag, with the provider healthy throughout;
// the ONLY difference is whether the watch kept producing. The old predicate saw
// 40–61 minutes of "silence" in both.

const MIN = 60_000;

/** `HH:MM` on the fixture night as a canonical instant. */
function at(hhmm: string): string {
  return `2026-08-08T${hhmm}:00Z`;
}

/**
 * Fold a night's pushes into the frontier state.
 *
 * Each entry is one successful push: when it landed, and what `MAX(stream.ts)` stood at
 * once it had been written. A watch on a wrist advances that value on every push even
 * when the push itself is an hour late; a watch on a charger leaves it exactly where it
 * was while the phone keeps pushing its own aggregates.
 */
function replay(
  pushes: readonly { pushedAt: string; frontier: string | null }[]
): StreamFrontierState | null {
  let state: StreamFrontierState | null = null;
  for (const p of pushes)
    state = observeFrontier(state, p.frontier, p.pushedAt);
  return state;
}

/** The signals a slot at `slotAt` would see, given the folded state. */
function signalsAt(
  slotAt: string,
  state: StreamFrontierState | null
): BedtimeWearSignals {
  const frontierMs = state?.frontierAt
    ? Date.parse(state.frontierAt)
    : undefined;
  return {
    ...OFF_WRIST,
    frontierAgeMin:
      frontierMs == null
        ? null
        : Math.floor((Date.parse(slotAt) - frontierMs) / MIN),
    syncsSinceAdvance: state?.syncsSinceAdvance ?? null,
  };
}

describe("the worn watch behind a slow pipeline (#2341)", () => {
  // 2026-08-08, the night this shipped wrong. `hr_minutes` ran continuously; the
  // pushes carrying those minutes ran 30–61 minutes behind. At the 22:00 slot the
  // frontier stood at 21:20 — exactly 40 minutes old, exactly the old tolerance — and
  // the push carrying the next 46 minutes of data landed five minutes after the
  // message went out.
  const worn = [
    { pushedAt: at("21:28"), frontier: at("20:46") },
    { pushedAt: at("21:44"), frontier: at("21:03") },
    { pushedAt: at("21:59"), frontier: at("21:20") },
  ];

  it("does not fire at the slot: the frontier is old, but it MOVED on every push", () => {
    const state = replay(worn);
    const signals = signalsAt(at("22:00"), state);
    // The quantity the old predicate thresholded, reproduced exactly — it is 40, which
    // is the floor, so the floor alone would have sent.
    expect(signals.frontierAgeMin).toBe(40);
    expect(signals.frontierAgeMin).toBeGreaterThanOrEqual(FLOOR);
    // And the quantity that replaced it says the opposite, unambiguously.
    expect(state!.syncsSinceAdvance).toBe(0);
    expect(bedtimeWearVerdict(signals)).toEqual({
      send: false,
      skip: "frontier-advanced",
    });
  });

  it("does not fire at the SECOND attempt of the slot either, an hour later", () => {
    // `slotAttempt` gives every slot two due attempts an hour apart. The lag does not
    // shrink in between — the 23:00 attempt sees a frontier ~40 minutes old again,
    // because the pipeline kept running exactly as far behind.
    const state = replay([
      ...worn,
      { pushedAt: at("22:05"), frontier: at("21:46") },
      { pushedAt: at("22:31"), frontier: at("22:20") },
    ]);
    const signals = signalsAt(at("23:00"), state);
    expect(signals.frontierAgeMin).toBe(40);
    expect(bedtimeWearVerdict(signals)).toEqual({
      send: false,
      skip: "frontier-advanced",
    });
  });

  it("stays silent even when the lag is 61 minutes — the p99 push gap", () => {
    // #2263's census: median 16, p90 34, p99 67 minutes. At the tail the observed
    // "silence" of a worn watch exceeds the 55 minutes the REAL incident shows, which
    // is the arithmetic that makes raising the number unavailable.
    const state = replay([
      { pushedAt: at("20:30"), frontier: at("19:35") },
      { pushedAt: at("21:20"), frontier: at("20:22") },
      { pushedAt: at("21:52"), frontier: at("20:59") },
    ]);
    const signals = signalsAt(at("22:00"), state);
    expect(signals.frontierAgeMin).toBe(61);
    expect(bedtimeWearVerdict(signals)).toEqual({
      send: false,
      skip: "frontier-advanced",
    });
  });
});

describe("the watch removed at 21:05 before a 22:00 slot (#2341)", () => {
  // The motivating incident. The same lagging pipeline, and the same three pushes —
  // but the watch stopped producing at 21:05, so each push carries the phone's own
  // aggregates and nothing newer for the stream.
  const removed = [
    { pushedAt: at("21:28"), frontier: at("21:05") },
    { pushedAt: at("21:44"), frontier: at("21:05") },
    { pushedAt: at("21:59"), frontier: at("21:05") },
  ];

  it("fires at the slot: frozen across two pushes AND past the floor", () => {
    const state = replay(removed);
    const signals = signalsAt(at("22:00"), state);
    expect(signals.frontierAgeMin).toBe(55);
    expect(state!.syncsSinceAdvance).toBe(2);
    expect(state!.syncsSinceAdvance).toBeGreaterThanOrEqual(
      FROZEN_SYNC_EVIDENCE
    );
    expect(bedtimeWearVerdict(signals)).toEqual({
      send: true,
      quietForMin: 55,
    });
  });

  it("still fires at the second attempt of the slot", () => {
    // Nothing has repaired it: the evidence only accumulates, and the frontier only
    // gets older.
    const state = replay([
      ...removed,
      { pushedAt: at("22:20"), frontier: at("21:05") },
      { pushedAt: at("22:44"), frontier: at("21:05") },
    ]);
    const signals = signalsAt(at("23:00"), state);
    expect(signals.frontierAgeMin).toBe(115);
    expect(bedtimeWearVerdict(signals)).toEqual({
      send: true,
      quietForMin: 115,
    });
  });

  it("does not fire on the FIRST quiet push alone — one is jitter", () => {
    const state = replay(removed.slice(0, 2));
    // Two pushes, one of which delivered the 21:05 frontier: only one has landed
    // against it, which is not yet evidence.
    expect(state!.syncsSinceAdvance).toBe(1);
    expect(bedtimeWearVerdict(signalsAt(at("22:00"), state))).toEqual({
      send: false,
      skip: "no-recent-sync",
    });
  });

  it("goes quiet again the moment the watch goes back on", () => {
    // The self-corrected night: four of the five measured quiet evenings ended this
    // way, unprompted. The advance resets the evidence in the same push that carries
    // it — no sweep, no marker to clear.
    const state = replay([
      ...removed,
      { pushedAt: at("22:10"), frontier: at("21:51") },
    ]);
    expect(state!.syncsSinceAdvance).toBe(0);
    // Asked LATE enough that the floor is cleared (49 minutes), so the only thing
    // that can still silence it is the advance itself.
    expect(signalsAt(at("22:40"), state).frontierAgeMin).toBe(49);
    expect(bedtimeWearVerdict(signalsAt(at("22:40"), state))).toEqual({
      send: false,
      skip: "frontier-advanced",
    });
  });

  it("does not fire when the phone stopped pushing too — that outage is #1685's", () => {
    // The one push that landed is the one that DELIVERED the 21:05 minutes; nothing
    // has landed since to contradict it, so the frontier was never observed frozen.
    // That outage is the connection detector's (#1685), and one fault gets one
    // contact.
    const state = replay([{ pushedAt: at("21:28"), frontier: at("21:05") }]);
    expect(state!.syncsSinceAdvance).toBe(0);
    expect(bedtimeWearVerdict(signalsAt(at("22:00"), state))).toEqual({
      send: false,
      skip: "frontier-advanced",
    });
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
