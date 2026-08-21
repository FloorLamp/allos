import { describe, it, expect } from "vitest";
import {
  REST_PRESETS_SEC,
  REST_MIN_SEC,
  REST_MAX_SEC,
  suggestedRestSec,
  clampRestSec,
  leadExerciseName,
  shouldDeferRowlessSave,
} from "../live-workout";

describe("suggestedRestSec", () => {
  it("gives isolation/accessory lifts the shortest rest", () => {
    expect(suggestedRestSec("Barbell Curl")).toBe(90);
    expect(suggestedRestSec("Lateral Raise")).toBe(90);
    expect(suggestedRestSec("Triceps Pushdown")).toBe(90);
  });

  it("gives big lower-body compounds the longest rest", () => {
    expect(suggestedRestSec("Back Squat")).toBe(180);
    expect(suggestedRestSec("Deadlift")).toBe(180);
    expect(suggestedRestSec("Leg Press")).toBe(180);
  });

  it("gives other compounds / upper lifts the middle default", () => {
    expect(suggestedRestSec("Barbell Bench Press")).toBe(120);
    expect(suggestedRestSec("Overhead Press")).toBe(120);
  });

  it("falls back to the middle default for an unknown/blank name", () => {
    expect(suggestedRestSec("")).toBe(120);
    expect(suggestedRestSec("Something Unlisted")).toBe(120);
  });

  it("reuses the same heavy classification as the next-set increment", () => {
    // Every preset is one of the offered chip values, so the suggested default
    // is always selectable in the UI.
    for (const name of ["Back Squat", "Barbell Curl", "Bench Press"]) {
      expect(REST_PRESETS_SEC).toContain(
        suggestedRestSec(name) as (typeof REST_PRESETS_SEC)[number]
      );
    }
  });
});

describe("clampRestSec", () => {
  it("clamps into the allowed range and rounds", () => {
    expect(clampRestSec(-30)).toBe(REST_MIN_SEC);
    expect(clampRestSec(9999)).toBe(REST_MAX_SEC);
    expect(clampRestSec(90.4)).toBe(90);
    expect(clampRestSec(90.6)).toBe(91);
  });

  it("returns the floor for a non-finite value", () => {
    expect(clampRestSec(NaN)).toBe(REST_MIN_SEC);
    expect(clampRestSec(Infinity)).toBe(REST_MIN_SEC);
  });
});

describe("leadExerciseName", () => {
  it("returns the last non-empty name (the part being worked)", () => {
    expect(leadExerciseName(["Bench Press", "Barbell Row"])).toBe(
      "Barbell Row"
    );
  });

  it("skips trailing blanks and trims", () => {
    expect(leadExerciseName(["Back Squat", "  ", ""])).toBe("Back Squat");
    expect(leadExerciseName(["  Deadlift  "])).toBe("Deadlift");
  });

  it("returns empty string when nothing is named", () => {
    expect(leadExerciseName([])).toBe("");
    expect(leadExerciseName(["", "  "])).toBe("");
  });
});

describe("shouldDeferRowlessSave (#3441)", () => {
  // The whole point of lifting this out of the hook: every term is checked in BOTH
  // directions. A clause mutated to be ALWAYS taken dies in an e2e run; a clause
  // mutated to be NEVER taken — which is where a wrong exemption would actually
  // live — sails through one, because no user path reaches the combination. These
  // four corners are the ones nothing else in the tree can see.
  const racing = { createPending: true, hasRow: false, closePath: false };

  it("defers a rowless mid-session save while the create-at-start is in flight", () => {
    // The defect itself: without this the save builds a null id and inserts a
    // SECOND row for one session.
    expect(shouldDeferRowlessSave(racing)).toBe(true);
  });

  it("does not defer once the form owns a row", () => {
    // An adopted row, an edit, or the form's own earlier create — the id is known,
    // so the save UPDATEs and there is nothing to wait for. Deferring here would
    // stall every save for the life of a create that already answered.
    expect(shouldDeferRowlessSave({ ...racing, hasRow: true })).toBe(false);
  });

  it("does not defer when no create-at-start is outstanding", () => {
    // Every ordinary create — "New activity", an offline capture, a repeat — is
    // rowless and must go straight through. This is the term whose failure would
    // stop the app saving anything at all.
    expect(shouldDeferRowlessSave({ ...racing, createPending: false })).toBe(
      false
    );
  });

  it("never defers a CLOSE-path flush, even mid-race", () => {
    // THE EXEMPTION NOTHING ELSE CAN SEE. A close abandons the session and the
    // provider invalidates the in-flight create in the same breath, so its answer
    // can never be adopted: deferring would hold the last edit behind a request
    // nobody is listening to, and the #1596 offline capture — reachable only from a
    // close-path persist — would stop happening on exactly the dead connection it
    // exists for. Mutate this to `false` and the whole e2e suite stays green.
    expect(shouldDeferRowlessSave({ ...racing, closePath: true })).toBe(false);
  });
});
