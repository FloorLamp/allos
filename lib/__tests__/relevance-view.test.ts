import { describe, expect, it } from "vitest";
import {
  droppedGroupsWarning,
  groupedRelevanceView,
} from "@/lib/relevance-view";
import { fuzzyFilter } from "@/lib/fuzzy";
import { SERIES_PICKER_GROUP_ORDER } from "@/lib/series-picker-options";

// The Combobox's pre-typing list, capped per group (#3410). The bug this pins: with
// one shared eight-row budget taken off the front, a picker fed TWO ranked
// vocabularies showed only the higher-ranked one — no header, no "more", and a list
// that looked complete because it was short.

// What the Combobox passes.
const ROWS = 8;

const named = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

// A groupFor built from a prefix→group table, the shape every real caller uses.
const byPrefix =
  (table: Record<string, string | null>) =>
  (option: string): string | null =>
    table[option.split(" ")[0]] ?? null;

describe("groupedRelevanceView", () => {
  it("is byte-identical to the old flat cap for a SINGLE vocabulary", () => {
    const options = named("Lift", 400);
    const view = groupedRelevanceView(options, () => "Exercises", ROWS);
    // The old behaviour, spelled the way the component spelled it.
    expect(view.rows).toEqual(fuzzyFilter(options, "", { limit: ROWS }));
    expect(view.rows).toEqual(options.slice(0, ROWS));
    expect(view.droppedGroups).toEqual([]);
  });

  it("is unchanged for a single vocabulary whose rows carry NO header", () => {
    const options = named("Lift", 40);
    const view = groupedRelevanceView(options, () => null, ROWS);
    expect(view.rows).toEqual(options.slice(0, ROWS));
    expect(view.droppedGroups).toEqual([]);
  });

  it("shows both vocabularies when a picker concatenates two ranked lists (#3220)", () => {
    // The exact shape that lost a vocabulary: a long ranked catalog first, a
    // shorter ranked one after it.
    const options = [...named("Lift", 200), ...named("Analyte", 50)];
    const groupFor = byPrefix({ Lift: "Exercises", Analyte: "Biomarkers" });
    const view = groupedRelevanceView(options, groupFor, ROWS);

    expect(view.rows).toHaveLength(ROWS);
    expect(view.rows.filter((o) => o.startsWith("Lift"))).toHaveLength(4);
    expect(view.rows.filter((o) => o.startsWith("Analyte"))).toHaveLength(4);
    expect(view.droppedGroups).toEqual([]);
    // The pre-fix list, for contrast: eight lifts and no analyte at all.
    expect(options.slice(0, ROWS).some((o) => o.startsWith("Analyte"))).toBe(
      false
    );
  });

  it("keeps the caller's order — the round-robin picks rows, it does not resort them", () => {
    const options = [...named("Lift", 200), ...named("Analyte", 50)];
    const groupFor = byPrefix({ Lift: "Exercises", Analyte: "Biomarkers" });
    const { rows } = groupedRelevanceView(options, groupFor, ROWS);
    expect(rows).toEqual([
      "Lift 1",
      "Lift 2",
      "Lift 3",
      "Lift 4",
      "Analyte 1",
      "Analyte 2",
      "Analyte 3",
      "Analyte 4",
    ]);
  });

  it("does not waste budget on a group that runs out — the biomarker picker's own shape", () => {
    // The shipped record-form picker: two due-or-flagged analytes, one measured,
    // and the whole ~200-row canonical vocabulary behind them. This is what it
    // showed before #3410 and what it must still show.
    const options = [
      ...named("Due", 2),
      ...named("Yours", 1),
      ...named("All", 200),
    ];
    const groupFor = byPrefix({
      Due: "Due or flagged",
      Yours: "Your markers",
      All: "All biomarkers",
    });
    const { rows, droppedGroups } = groupedRelevanceView(
      options,
      groupFor,
      ROWS
    );
    expect(rows).toEqual(options.slice(0, ROWS));
    expect(droppedGroups).toEqual([]);
  });

  it("shows everything, in order, when the whole list fits", () => {
    const options = ["AM stack", "PM stack", "Travel"];
    const view = groupedRelevanceView(
      options,
      (o) => (o.endsWith("stack") ? "Stacks" : "Other"),
      ROWS
    );
    expect(view.rows).toEqual(options);
    expect(view.droppedGroups).toEqual([]);
  });

  it("never renders more rows than the cap, whatever the group count", () => {
    for (const groups of [2, 3, 5, 8, 9, 20]) {
      const options: string[] = [];
      for (let g = 0; g < groups; g++) options.push(...named(`G${g}`, 30));
      const view = groupedRelevanceView(options, (o) => o.split(" ")[0], ROWS);
      expect(view.rows.length, `${groups} groups`).toBe(ROWS);
    }
  });
});

// #3410 item (3). A guard is worth nothing until it has been run over input authored
// to break it AND shown to stay quiet on the benign case — a warning that fires on
// ordinary pickers is deleted within a week, taking the real guard with it.
describe("droppedGroups: the dev-time guard", () => {
  it("SEES a picker with more groups than the list has rows", () => {
    const options: string[] = [];
    for (let g = 0; g < 12; g++) options.push(...named(`G${g}`, 5));
    const view = groupedRelevanceView(options, (o) => o.split(" ")[0], ROWS);
    // Eight rows, eight groups represented, four groups with nothing at all.
    expect(view.rows).toHaveLength(ROWS);
    expect(view.droppedGroups).toEqual(["G8", "G9", "G10", "G11"]);
  });

  it("SEES an unheaded bucket that got squeezed out, and names it", () => {
    const options: string[] = [];
    for (let g = 0; g < 8; g++) options.push(...named(`G${g}`, 5));
    options.push("Unheaded 1");
    const view = groupedRelevanceView(
      options,
      (o) => (o.startsWith("Unheaded") ? null : o.split(" ")[0]),
      ROWS
    );
    expect(view.droppedGroups).toEqual([null]);
    expect(droppedGroupsWarning(view.droppedGroups, ROWS)).toContain(
      "(no header)"
    );
  });

  it("names the groups it dropped, in the caller's order", () => {
    const options: string[] = [];
    for (const g of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
      options.push(...named(g, 3));
    }
    const view = groupedRelevanceView(options, (o) => o.split(" ")[0], ROWS);
    const message = droppedGroupsWarning(view.droppedGroups, ROWS);
    expect(message).toContain("I");
    expect(message).toContain("8 rows");
  });

  it("stays SILENT on every group count a shipped picker actually has", () => {
    // The Trends series pickers are the widest shipped list: four headers plus the
    // ungrouped "— none —" row. Every other grouped picker has three or fewer.
    const buckets: (string | null)[] = [null, ...SERIES_PICKER_GROUP_ORDER];
    expect(buckets.length).toBeLessThanOrEqual(ROWS);
    const options: string[] = [];
    const group = new Map<string, string | null>();
    buckets.forEach((bucket, i) => {
      for (const option of named(`B${i}`, 60)) {
        options.push(option);
        group.set(option, bucket);
      }
    });
    const view = groupedRelevanceView(
      options,
      (o) => group.get(o) ?? null,
      ROWS
    );
    expect(view.droppedGroups).toEqual([]);
    // …and each of the five buckets is actually represented, which is the claim.
    expect(new Set(view.rows.map((o) => group.get(o))).size).toBe(
      buckets.length
    );
  });

  it("stays SILENT on the single-vocabulary picker, the benign case", () => {
    const view = groupedRelevanceView(
      named("Lift", 400),
      () => "Exercises",
      ROWS
    );
    expect(view.droppedGroups).toEqual([]);
  });
});
