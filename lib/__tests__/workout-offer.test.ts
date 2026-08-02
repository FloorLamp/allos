import { describe, expect, it } from "vitest";
import {
  RESUME_WORKOUT_LABEL,
  START_WORKOUT_LABEL,
  workoutOffer,
} from "@/lib/workout-offer";

// The #1893 offer state: the ONE derivation the bolt, the palette's live action, the
// Journal aside, and the routine card all render, and that openLive/openSession enforce.
// The truth table below is the whole contract — a label that says "Start workout" while a
// session is running is exactly the bug this replaces.
describe("workoutOffer (#1893)", () => {
  it("offers a START only when nothing is running", () => {
    const offer = workoutOffer({ mounted: false, hydrated: false });
    expect(offer.kind).toBe("start");
    expect(offer.label).toBe(START_WORKOUT_LABEL);
  });

  it("offers a RESUME from the mounted session when one is live in this client", () => {
    const offer = workoutOffer({ mounted: true, hydrated: false });
    expect(offer).toEqual({
      kind: "resume",
      label: RESUME_WORKOUT_LABEL,
      from: "mounted",
    });
  });

  it("offers a RESUME from the server-hydrated session after a reload", () => {
    const offer = workoutOffer({ mounted: false, hydrated: true });
    expect(offer).toEqual({
      kind: "resume",
      label: RESUME_WORKOUT_LABEL,
      from: "hydrated",
    });
  });

  it("prefers the MOUNTED session over the hydrated one", () => {
    // The mounted form holds unsaved in-flight input and the running rest timer;
    // re-hydrating from the persisted draft would throw that away.
    const offer = workoutOffer({ mounted: true, hydrated: true });
    expect(offer).toEqual({
      kind: "resume",
      label: RESUME_WORKOUT_LABEL,
      from: "mounted",
    });
  });

  it("never labels a resume as a start", () => {
    for (const mounted of [true, false]) {
      for (const hydrated of [true, false]) {
        const offer = workoutOffer({ mounted, hydrated });
        const live = mounted || hydrated;
        expect(offer.kind).toBe(live ? "resume" : "start");
        expect(offer.label).toBe(
          live ? RESUME_WORKOUT_LABEL : START_WORKOUT_LABEL
        );
      }
    }
  });
});
