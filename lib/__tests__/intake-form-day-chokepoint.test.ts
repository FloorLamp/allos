// One profile-local day per intake-form door (#4609).
//
// lib/intake-form-context.ts resolves the day ONCE and publishes it as `todayStr`,
// the same day its pediatric context carries. Inside IntakeItemForm the two halves
// are read separately: the weight-staleness gate reads `pediatric.today` and the
// start-date seed reads `todayStr`. They agree only while the host passes the
// loader's day through. `loadMedicationsData` used to call `today(profileId)` again
// a few lines below the loader, and THAT value was the `todayStr` handed to the add
// workspace and the med card — so a request crossing profile-local midnight between
// the two calls seeded a start date one day off the day the staleness gate had
// already used.
//
// A running test cannot catch that: the two calls are consecutive statements in one
// synchronous function, and the clock seam (lib/clock.ts) freezes a run rather than
// advancing it mid-call. So the guard is structural, in the idiom of
// age-as-of-scan.test.ts — the medications loader is read as TEXT, through the
// shared scanner, and must resolve no day of its own. If a future reader needs the
// day here, take it from the intake context; that is the whole point.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MED_DATA = "app/(app)/medications/med-data.ts";

// Comments stripped, line numbers preserved, so prose ABOUT today() is not a hit and
// an offender can still be reported at its real line.
const code = stripComments(fs.readFileSync(path.join(REPO, MED_DATA), "utf8"));

describe("the medications loader takes its day from the intake context (#4609)", () => {
  it("loadMedicationsData resolves no day of its own", () => {
    const offenders = code
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\btoday\s*\(/.test(line))
      .map(({ line, n }) => `${MED_DATA}:${n} — ${line.trim()}`);
    expect(
      offenders,
      "The day handed to IntakeItemForm must be the one the intake context " +
        "resolved, or the start-date seed and the weight-staleness gate can land " +
        "on different days across profile-local midnight. Use " +
        "`intakeForm.todayStr` instead of calling today() here."
    ).toEqual([]);
  });

  it("and does take the loader's day — the scan is not vacuous", () => {
    expect(code).toContain("intakeForm.todayStr");
    // The shape the scan would catch, proving the pattern matches real source.
    expect(/\btoday\s*\(/.test("  const todayStr = today(profileId);")).toBe(
      true
    );
  });
});
