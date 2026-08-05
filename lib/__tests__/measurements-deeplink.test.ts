import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deepLinkFieldId,
  deepLinkGroup,
  measurementFieldGroup,
  measurementGroupSummary,
  measurementsDeepLinked,
  GROUPED_MEASUREMENT_FIELD_IDS,
  MEASUREMENT_GROUPS,
  UNGROUPED_MEASUREMENT_FIELD_IDS,
} from "../measurements-deeplink";

// The ONE table behind the combined measurements form (#1486, #2014): which field
// a deep link names, and which disclosure group holds it. The completeness checks
// below are source scans in the repo's established idiom — they read the module and
// the form as TEXT, so a new field cannot be added on either side without a group.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FORM = "app/(app)/trends/MeasurementsQuickAdd.tsx";
const MODULE = "lib/measurements-deeplink.ts";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("deepLinkFieldId", () => {
  it("maps the care-surface and palette conventions onto the one form", () => {
    expect(deepLinkFieldId("blood-pressure", null)).toBe("m-systolic");
    expect(deepLinkFieldId("sleep", null)).toBe("m-sleep");
    expect(deepLinkFieldId("height", null)).toBe("m-height");
    expect(deepLinkFieldId(null, "weight")).toBe("m-weight");
    expect(deepLinkFieldId(null, "vitals")).toBe("m-resting-hr");
  });

  it("focuses nothing for an unrecognized or absent value", () => {
    expect(deepLinkFieldId("not-a-field", null)).toBeNull();
    expect(deepLinkFieldId(null, null)).toBeNull();
    expect(measurementsDeepLinked(null, null)).toBe(false);
    expect(measurementsDeepLinked("sleep", null)).toBe(true);
  });
});

describe("field → group", () => {
  it("opens the group holding the deep-linked field", () => {
    expect(deepLinkGroup("blood-pressure", null)).toBe("vitals");
    expect(deepLinkGroup("sleep", null)).toBe("sleep");
    expect(deepLinkGroup("height", null)).toBe("body");
    expect(deepLinkGroup(null, "weight")).toBe("body");
    expect(deepLinkGroup(null, "vitals")).toBe("vitals");
    expect(deepLinkGroup(null, null)).toBeNull();
  });

  it("is TOTAL over every field id the deep-link table can produce", () => {
    // Every `return "m-…"` in the module — read from the source so a new deep-link
    // target cannot be added without a group to open (#2014).
    const produced = [
      ...read(MODULE).matchAll(/return\s+"(m-[a-z0-9-]+)"/g),
    ].map((m) => m[1]);
    expect(produced.length).toBeGreaterThan(0);
    for (const id of produced) {
      expect(measurementFieldGroup(id), `${id} has no group`).not.toBeNull();
    }
  });

  it("covers every field the form renders, and names none it does not", () => {
    const rendered = new Set(
      [...read(FORM).matchAll(/id="(m-[a-z0-9-]+)"/g)].map((m) => m[1])
    );
    const known = new Set([
      ...GROUPED_MEASUREMENT_FIELD_IDS,
      ...UNGROUPED_MEASUREMENT_FIELD_IDS,
    ]);
    for (const id of rendered) {
      expect(known.has(id), `${id} is rendered but ungrouped`).toBe(true);
    }
    for (const id of known) {
      expect(rendered.has(id), `${id} is grouped but not rendered`).toBe(true);
    }
  });

  it("gives an unknown id no group rather than a default one", () => {
    expect(measurementFieldGroup("m-not-a-field")).toBeNull();
    expect(measurementFieldGroup(null)).toBeNull();
  });
});

describe("measurementGroupSummary", () => {
  const from =
    (values: Record<string, string>) =>
    (name: string): string | null =>
      values[name] ?? null;

  it("is null for a group holding nothing", () => {
    for (const group of MEASUREMENT_GROUPS) {
      expect(measurementGroupSummary(group, from({}))).toBeNull();
    }
    // Blank and whitespace-only are "nothing", not a reading.
    expect(measurementGroupSummary("body", from({ weight: "  " }))).toBeNull();
  });

  it("summarizes a blood pressure as ONE reading", () => {
    expect(
      measurementGroupSummary("vitals", from({ systolic: "120", diastolic: "80" }))
    ).toBe("120/80");
    // Half-typed still announces itself — the value must not be invisible.
    expect(measurementGroupSummary("vitals", from({ systolic: "120" }))).toBe(
      "120/—"
    );
  });

  it("carries the unit the user chose", () => {
    expect(
      measurementGroupSummary(
        "vitals",
        from({ temperature: "38.2", temp_unit: "C" })
      )
    ).toBe("38.2°C");
    expect(
      measurementGroupSummary(
        "vitals",
        from({ glucose: "5.2", glucose_unit: "mmol/L" })
      )
    ).toBe("5.2 mmol/L");
    expect(
      measurementGroupSummary("body", from({ weight: "165", weight_unit: "lb" }))
    ).toBe("165 lb");
  });

  it("joins everything a group holds", () => {
    expect(
      measurementGroupSummary(
        "vitals",
        from({
          systolic: "118",
          diastolic: "76",
          resting_hr: "54",
          spo2: "98",
        })
      )
    ).toBe("118/76 · 54 bpm · 98%");
    expect(
      measurementGroupSummary("sleep", from({ sleep_hours: "7.5", hrv: "48" }))
    ).toBe("7.5 hrs sleep · 48 ms HRV");
  });
});
