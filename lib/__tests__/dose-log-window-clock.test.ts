import { describe, it, expect, afterEach } from "vitest";
import { now as clockNow } from "../clock";
import { dateStrInTz } from "../date";
import {
  isGivenAtAccepted,
  isHistoricalDoseTimeAccepted,
} from "../dose-log-window";

// WHICH CLOCK the dose-log future guards judge a recorded_at against (#2031).
//
// Both guards take `now` as a required argument, and every production call site
// passes `now()` from the clock seam. That is not a stylistic choice: the guards
// also compare the recorded_at's profile-local DATE against `todayStr`, which always
// comes from `today()` — the seam — and the recorded_at itself is seam-derived too
// (a stored stamp is written by `sqlNow()`, a form-entered one is built from a
// `today()`-anchored date field). Feeding the guard a real `new Date()` while its
// other half reads the frozen clock is what opened the ~30-minute daily band:
// inside #1464's forward nudge the frozen instant sits in the real future, so the
// app refused its own timestamps with "not in the future".
//
// These cases pin the composition the call sites use — guard + seam — in BOTH skew
// directions and with the override absent, which is the production configuration.

const TZ = "UTC";
const MINUTE = 60_000;

function withFrozen<T>(iso: string | undefined, fn: () => T): T {
  const previous = process.env.ALLOS_TEST_NOW;
  if (iso === undefined) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = iso;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = previous;
  }
}

// The app's today, exactly as `today()` derives it for a UTC profile.
function appToday(): string {
  return dateStrInTz(TZ, clockNow());
}

afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

describe("dose-log future guards judge on the app clock (#2031)", () => {
  // The band itself: real 23:38Z, frozen nudged to the next day's 00:30Z, so the
  // app's own "now" is 52 minutes in the real future.
  const REAL_IN_BAND = new Date("2026-07-15T23:38:00Z");
  const FROZEN_NUDGED = new Date("2026-07-16T00:30:00Z");

  it("accepts a stamp the app itself just wrote while the frozen clock leads real time", () => {
    withFrozen(FROZEN_NUDGED.toISOString(), () => {
      const stored = clockNow(); // what sqlNow() would have written on a confirm
      expect(appToday()).toBe("2026-07-16");

      // On the app clock — the shipped composition — the amend round-trips.
      expect(
        isHistoricalDoseTimeAccepted(TZ, appToday(), stored, clockNow())
      ).toBe(true);
      expect(isGivenAtAccepted(TZ, appToday(), stored, clockNow())).toBe(true);

      // On the real wall clock — the pre-#2031 composition — the same stamp is
      // refused, which is the false red this issue fixed.
      expect(
        isHistoricalDoseTimeAccepted(TZ, appToday(), stored, REAL_IN_BAND)
      ).toBe(false);
      expect(isGivenAtAccepted(TZ, appToday(), stored, REAL_IN_BAND)).toBe(
        false
      );
    });
  });

  it("still refuses a genuinely future stamp inside the band — the #797 rule is intact", () => {
    withFrozen(FROZEN_NUDGED.toISOString(), () => {
      const tomorrowish = new Date(FROZEN_NUDGED.getTime() + 26 * 60 * MINUTE);
      expect(
        isHistoricalDoseTimeAccepted(TZ, appToday(), tomorrowish, clockNow())
      ).toBe(false);
      expect(isGivenAtAccepted(TZ, appToday(), tomorrowish, clockNow())).toBe(
        false
      );
    });
  });

  it("accepts across the other skew direction — a frozen clock trailing real time", () => {
    // The ordinary out-of-band shape: the suite froze at its start and real time
    // has since moved on (up to a repeat-each lane's ~90 minutes). A stamp written
    // from the frozen clock is in the past for both clocks, so there is no band
    // here before or after the change.
    withFrozen("2026-07-15T09:00:00Z", () => {
      const stored = clockNow();
      expect(
        isHistoricalDoseTimeAccepted(TZ, appToday(), stored, clockNow())
      ).toBe(true);
      expect(
        isHistoricalDoseTimeAccepted(
          TZ,
          appToday(),
          stored,
          new Date("2026-07-15T10:30:00Z")
        )
      ).toBe(true);
    });
  });

  it("refuses a stamp ahead of a trailing frozen clock, in the app's own frame", () => {
    // The mirror case, and the reason the guard follows the seam rather than the
    // later of the two clocks: with the app pinned to 09:00, an instant at real
    // 10:30 is the app's future and is refused — the same answer the app gives for
    // every other "is this in the future" question it asks while frozen.
    withFrozen("2026-07-15T09:00:00Z", () => {
      expect(
        isHistoricalDoseTimeAccepted(
          TZ,
          appToday(),
          new Date("2026-07-15T10:30:00Z"),
          clockNow()
        )
      ).toBe(false);
    });
  });

  it("is byte-identical to real time with no override — the production configuration", () => {
    withFrozen(undefined, () => {
      const seam = clockNow().getTime();
      expect(Math.abs(seam - Date.now())).toBeLessThan(1_000);

      const past = new Date(Date.now() - 90 * MINUTE);
      const future = new Date(Date.now() + 90 * MINUTE);
      expect(
        isHistoricalDoseTimeAccepted(TZ, appToday(), past, clockNow())
      ).toBe(true);
      expect(
        isHistoricalDoseTimeAccepted(TZ, appToday(), future, clockNow())
      ).toBe(false);
      expect(isGivenAtAccepted(TZ, appToday(), past, clockNow())).toBe(true);
      expect(isGivenAtAccepted(TZ, appToday(), future, clockNow())).toBe(false);
    });
  });
});
