import { describe, expect, it } from "vitest";
import {
  arrivalLagMedian,
  arrivalWait,
  arrivalWaitWindowMin,
} from "@/lib/arrival-wait";

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

  it("gives up at the max, and quotes no time it will not be waiting at", () => {
    // A measured six-hour lag would put the window at 390; the max is 180 and it
    // wins. This is the difference between an informative state and a stuck one.
    expect(arrivalWaitWindowMin({ ...SLEEP, measuredLagMin: 360 })).toBe(180);

    // AND THE ETA IS BOUNDED BY THE SAME NUMBER (#5127 falsifying pass, F4). This
    // answered `etaMin: 360` before: the sleep tile read "usually in by ~13:40" at
    // 08:40 and then said the night had not synced at 10:01 — 220 minutes before the
    // clock it had just promised. A wait may not name a time it will not still be
    // waiting at, so the measurement is dropped and the consumer degrades to the same
    // unquantified line it gives a profile that measured nothing at all.
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 360, elapsedMin: 180 })
    ).toEqual({ kind: "waiting", etaMin: null });

    // A measurement exactly AT the window is still quotable: the wait is still running
    // at that minute, so the time is one it can keep.
    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 180, elapsedMin: 10 })
    ).toEqual({ kind: "waiting", etaMin: 180 });

    expect(
      arrivalWait({ ...SLEEP, measuredLagMin: 360, elapsedMin: 181 })
    ).toEqual({ kind: "overdue" });
  });

  it("lets a fast profile's own measurement shorten the wait", () => {
    // Where the wait's whole purpose is the measurement, a quicker pipeline is a
    // shorter wait. The sleep tile is that shape: the state exists to say "your night
    // has not landed yet", so a source that lands sooner should stop saying it sooner.
    const fast = { defaultLagMin: 120, graceMin: 0, maxMin: 120 };
    expect(arrivalWaitWindowMin({ ...fast, measuredLagMin: 20 })).toBe(20);
    expect(arrivalWaitWindowMin({ ...fast, measuredLagMin: null })).toBe(120);
  });

  it("but a floor stops a measurement SILENCING a consumer (#5127 review)", () => {
    // The other shape, and the one that had a defect in it. Where the bound exists to
    // give a pipeline time to deliver — the practice recap, which sends the moment its
    // coverage arrives — a quicker profile needs no shorter wait, and shortening it
    // only takes the send away from the profiles whose data came soonest. `minWindowMin`
    // is what says a measurement may only ever LENGTHEN this one.
    const floored = {
      defaultLagMin: 120,
      graceMin: 0,
      minWindowMin: 120,
      maxMin: 720,
    };
    expect(arrivalWaitWindowMin({ ...floored, measuredLagMin: 20 })).toBe(120);
    expect(arrivalWaitWindowMin({ ...floored, measuredLagMin: null })).toBe(
      120
    );
    // …and a genuinely slower pipeline still gets its own longer bound, which is what
    // the measurement is for.
    expect(arrivalWaitWindowMin({ ...floored, measuredLagMin: 180 })).toBe(180);
    // The max still ends it.
    expect(arrivalWaitWindowMin({ ...floored, measuredLagMin: 900 })).toBe(720);
  });
});

describe("arrivalLagMedian", () => {
  it("is null under the gate and never zero above it (#5127 F2)", () => {
    expect(arrivalLagMedian([10, 20, 30, 40])).toBeNull();
    // ZERO AND ABSENT MUST BE DISTINGUISHABLE. Every consumer branches on null, so a
    // measured 0 would put the ABSENT case and the FASTEST case at two ends of one
    // `??` — a source landing inside thirty seconds reading as no measurement to one
    // consumer and as a zero-length window to another.
    expect(arrivalLagMedian([0, 0, 0, 0, 0, 1])).toBe(1);
    expect(arrivalLagMedian([0, 0, 0, 0, 0])).toBe(1);
    // An ordinary sample is untouched.
    expect(arrivalLagMedian([30, 40, 50, 60, 70])).toBe(50);
  });

  // THE SORT IS LOAD-BEARING AND NOTHING SAW IT (#5127 falsifying pass). Deleting
  // `.sort((a, b) => a - b)` left the whole pure tier green, because every fixture
  // above happens to hand it an already-ascending or all-equal array. That is not what
  // the producer hands it: `getSleepArrivalLagMinutes` reads rows `ORDER BY
  // r.created_at DESC` — newest ARRIVAL first — so the lags arrive in chronological
  // order and a profile whose pipeline varies delivers them unsorted. Over the pass's
  // 400,000 random row sets the missing sort changed the answer in 298,940 of them.
  //
  // Both parities, because they fail differently: an odd count reads the wrong single
  // element, an even count averages the wrong pair.
  it("sorts the sample before taking the middle of it", () => {
    // Sorted: 10, 20, 30, 40, 100 → 30. Unsorted, the third element is 20.
    expect(arrivalLagMedian([10, 100, 20, 30, 40])).toBe(30);
    // Sorted: 10, 20, 30, 40, 50, 100 → (30 + 40) / 2 = 35. Unsorted: (20 + 30) / 2.
    expect(arrivalLagMedian([100, 10, 20, 30, 40, 50])).toBe(35);
    // And the answer does not depend on the order it was given in.
    expect(arrivalLagMedian([10, 100, 20, 30, 40])).toBe(
      arrivalLagMedian([100, 40, 30, 20, 10])
    );
  });
});
