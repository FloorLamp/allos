import { describe, expect, it } from "vitest";
import { arrivalWait, arrivalWaitWindowMin } from "@/lib/arrival-wait";

// #5001 — the ONE bounded arrival wait, extracted from the sleep morning state.
//
// The two things this model exists to keep straight are the two things asserted
// hardest below: a default BOUNDS a wait but is never quoted as an ETA, and every
// wait ends at its max whatever the measurement says.

const SLEEP = {
  defaultLagMin: 90,
  graceMin: 30,
  maxMin: 180,
};

describe("arrivalWait", () => {
  it("is ready before its origin, because nothing is due yet", () => {
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 70, elapsedMin: -1 })
    ).toEqual({ kind: "ready" });
  });

  it("waits inside the window and quotes the MEASURED lag as the ETA", () => {
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 70, elapsedMin: 0 })
    ).toEqual({ kind: "waiting", etaMin: 70 });
    // 70 + 30 grace — the last minute inside is still waiting.
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 70, elapsedMin: 100 })
    ).toEqual({ kind: "waiting", etaMin: 70 });
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 70, elapsedMin: 101 })
    ).toEqual({ kind: "overdue" });
  });

  it("waits on the DEFAULT but quotes nothing, which is the whole shape", () => {
    // Under the sample gate the producer hands over null. The wait still has a
    // bound — 90 + 30 — and still has no promise to make about when.
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: null, elapsedMin: 100 })
    ).toEqual({ kind: "waiting", etaMin: null });
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: null, elapsedMin: 120 })
    ).toEqual({ kind: "waiting", etaMin: null });
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: null, elapsedMin: 121 })
    ).toEqual({ kind: "overdue" });
  });

  it("gives up at the max however slow the measurement says the source is", () => {
    // A measured six-hour lag would put the window at 390; the max is 180 and it
    // wins. This is the difference between an informative state and a stuck one.
    expect(arrivalWaitWindowMin({ ...SLEEP, measuredLagMin: 360 })).toBe(180);
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 360, elapsedMin: 180 })
    ).toEqual({ kind: "waiting", etaMin: 360 });
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 360, elapsedMin: 181 })
    ).toEqual({ kind: "overdue" });
  });

  it("lets a fast profile's own measurement shorten the wait", () => {
    // The reason the practice bound reads this rather than a constant: a pipeline
    // measured at 20 minutes should not hold a state open for two hours.
    const fast = { defaultLagMin: 120, graceMin: 0, maxMin: 120 };
    expect(arrivalWaitWindowMin({ ...fast, measuredLagMin: 20 })).toBe(20);
    expect(arrivalWaitWindowMin({ ...fast, measuredLagMin: null })).toBe(120);
  });
});
