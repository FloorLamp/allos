import { describe, expect, it } from "vitest";
import {
  droppedGroupsWarning,
  groupedRelevanceView,
} from "@/lib/relevance-view";
import { fuzzyFilter } from "@/lib/fuzzy";
import {
  SERIES_PICKER_GROUP_ORDER,
  SERIES_PICKER_METRICS_GROUP,
} from "@/lib/series-picker-options";
import { BIOMARKER_GROUP_LABELS } from "@/lib/biomarker-rank";

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
    // THE CLAIM IS REPRESENTATION, not an even split: the second vocabulary is
    // present, so it gets a header, so it is not a list that vanished. It gets ONE
    // row, because the caller ranked it second and this component will not overrule
    // that beyond the one row the fix requires.
    expect(view.rows.filter((o) => o.startsWith("Analyte"))).toEqual([
      "Analyte 1",
    ]);
    expect(view.rows.filter((o) => o.startsWith("Lift"))).toHaveLength(7);
    expect(view.droppedGroups).toEqual([]);
    // The pre-fix list, for contrast: eight lifts and no analyte at all.
    expect(options.slice(0, ROWS).some((o) => o.startsWith("Analyte"))).toBe(
      false
    );
  });

  it("keeps the caller's order — it picks rows, it does not resort them", () => {
    const options = [...named("Lift", 200), ...named("Analyte", 50)];
    const groupFor = byPrefix({ Lift: "Exercises", Analyte: "Biomarkers" });
    const { rows } = groupedRelevanceView(options, groupFor, ROWS);
    expect(rows).toEqual([
      "Lift 1",
      "Lift 2",
      "Lift 3",
      "Lift 4",
      "Lift 5",
      "Lift 6",
      "Lift 7",
      "Analyte 1",
    ]);
  });

  // THE PRIORITY QUESTION, and the reason the rows are not shared out evenly. For
  // every grouped picker that ships, the caller's group order is a PRIORITY order:
  // "Due or flagged" is the app saying act on this. These are the record form's own
  // three-bucket shape (components/ResultForm.tsx over lib/biomarker-rank.ts) at
  // sizes a full panel with several out-of-range results reaches easily.
  it("does not hand the urgent bucket's rows to the alphabetical tail", () => {
    const groupFor = byPrefix({
      due: "Due or flagged",
      yours: "Your markers",
      all: "All biomarkers",
    });
    const shape = (dueN: number, yoursN: number, allN: number) => {
      const options = [
        ...named("due", dueN),
        ...named("yours", yoursN),
        ...named("all", allN),
      ];
      const { rows } = groupedRelevanceView(options, groupFor, ROWS);
      return [
        rows.filter((o) => o.startsWith("due")).length,
        rows.filter((o) => o.startsWith("yours")).length,
        rows.filter((o) => o.startsWith("all")).length,
      ];
    };
    // 8 flagged analytes and none of the profile's own: 7 of the 8 keep their row,
    // and the tail's single row is the header that fixes #3410. An even split would
    // have given the tail four of them.
    expect(shape(8, 0, 200)).toEqual([7, 0, 1]);
    expect(shape(12, 20, 200)).toEqual([6, 1, 1]);
  });

  it("does not waste budget on a group that runs out — the biomarker picker's shape today", () => {
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

  // THE DEGENERATE INPUTS, pinned because the selection rule CHANGED inside this PR
  // (a round-robin, then the floor-plus-remainder above) and these are the edges a
  // rewrite silently moves. `limit` reaches this function from RELEVANCE_ROWS, so a
  // zero or a negative is not reachable today — which is exactly why nothing else
  // would notice if a future edit made them throw or over-emit.
  it("emits nothing for a limit of zero or below, and reports every group", () => {
    const options = [...named("Lift", 5), ...named("Analyte", 5)];
    const groupFor = byPrefix({ Lift: "Exercises", Analyte: "Biomarkers" });
    for (const limit of [0, -1]) {
      const view = groupedRelevanceView(options, groupFor, limit);
      expect(view.rows, `limit ${limit}`).toEqual([]);
      // No row means no group is represented, and the guard must say so rather
      // than reporting a clean sweep it never took.
      expect(view.droppedGroups, `limit ${limit}`).toEqual([
        "Exercises",
        "Biomarkers",
      ]);
    }
  });

  // BOTH PATHS, because the sentence above says "a limit of zero or below" and the
  // single-vocabulary SHORT-CIRCUIT is a second path to the same claim. It used to
  // disagree in both directions — `options.slice(0, -1)` is every row but the last,
  // so a negative cap emitted n-1 rows and reported no dropped group at all.
  it("says the same thing on the single-vocabulary path", () => {
    const options = named("Lift", 4);
    for (const limit of [0, -1]) {
      const view = groupedRelevanceView(options, () => "Exercises", limit);
      expect(view.rows, `limit ${limit}`).toEqual([]);
      expect(view.droppedGroups, `limit ${limit}`).toEqual(["Exercises"]);
    }
    // …and the empty list still has no group to report, on either path.
    expect(groupedRelevanceView([], () => "Exercises", 0)).toEqual({
      rows: [],
      droppedGroups: [],
    });
  });

  it("spends a single row on the first group and names the rest", () => {
    const options = [...named("Lift", 5), ...named("Analyte", 5)];
    const view = groupedRelevanceView(
      options,
      byPrefix({ Lift: "Exercises", Analyte: "Biomarkers" }),
      1
    );
    expect(view.rows).toEqual(["Lift 1"]);
    expect(view.droppedGroups).toEqual(["Biomarkers"]);
  });

  it("takes the empty list as one bucket, not as a phantom group", () => {
    const view = groupedRelevanceView([], () => "Exercises", ROWS);
    expect(view.rows).toEqual([]);
    expect(view.droppedGroups).toEqual([]);
  });

  // THE UNIQUENESS QUESTION, and the reason this module does not need an answer.
  // Rows are chosen and emitted BY INDEX, so a list carrying the same string twice
  // behaves exactly as `options.slice(0, limit)` always did. It matters because the
  // real concatenations are not unique — `curatedMedicationOptions()` and
  // `curatedSupplementOptions()` both carry "Melatonin" and "Magnesium Oxide" — and
  // `Combobox` keys its rendered rows by the option string, so a duplicate reaching
  // the visible eight is a caller-side problem there. This pins that grouping cannot
  // CREATE one that the flat cap would not have shown: both copies appear here only
  // because the flat cap would have shown both too.
  it("chooses rows by index, so a repeated label is not a special case", () => {
    const options = ["Melatonin", "Zinc", "Melatonin", "Iron"];
    const flat = groupedRelevanceView(options, () => "Supplements", ROWS);
    expect(flat.rows).toEqual(options);

    // The same duplicate split across two groups: still index-chosen, still every
    // row, still in the caller's order.
    const split = groupedRelevanceView(
      options,
      (o) => (o === "Iron" ? "Minerals" : "Supplements"),
      ROWS
    );
    expect(split.rows).toEqual(options);
    expect(split.droppedGroups).toEqual([]);
  });

  it("cannot make a duplicate visible that the flat cap would not have shown", () => {
    // THE SHAPE THE REVIEW ASKED ABOUT: two catalogs concatenated where one label —
    // "Melatonin" is the real one — appears in both halves. The worry was that
    // grouping could pull BOTH copies into the visible eight by spending a row on
    // each group, and it cannot, for a reason worth writing down. `groupFor` is a
    // function of the STRING, so two identical strings ALWAYS land in the same
    // bucket; the later copy is therefore never a bucket's FIRST index, and the only
    // other way in is the remainder pass, which never reaches past `limit - 1`.
    // So a repeated row can only be shown when the old flat cap showed it too.
    const options = [
      "Melatonin",
      ...named("Med", 8),
      "Melatonin",
      ...named("Supp", 4),
    ];
    const groupFor = (o: string) =>
      o.startsWith("Supp") ? "Supplements" : "Medications";
    const { rows } = groupedRelevanceView(options, groupFor, ROWS);
    const flat = options.slice(0, ROWS);
    const count = (list: readonly string[], name: string) =>
      list.filter((o) => o === name).length;

    // Not vacuous: the grouped list genuinely differs from the flat cap — that is
    // the #3410 fix, one row spent so "Supplements" gets a header.
    expect(rows).not.toEqual(flat);
    expect(rows).toContain("Supp 1");
    expect(flat).not.toContain("Supp 1");

    // Only ONE Melatonin, exactly as before.
    expect(count(rows, "Melatonin")).toBe(1);
    // The general claim: grouping never MANUFACTURES a repeat. A row may be new
    // (that is the header the fix buys); a row shown twice must have been shown
    // twice by the flat cap.
    for (const label of new Set(rows)) {
      if (count(rows, label) > 1) {
        expect(count(flat, label), label).toBeGreaterThanOrEqual(
          count(rows, label)
        );
      }
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
// WHAT THE FOUR SHIPPED GROUPED PICKERS ACTUALLY SHOW (#3410).
//
// The PR body discloses which lists move and by how much, and a disclosure written
// only in prose is a number nobody can re-derive. These are the same measurements,
// in the tree, over the REAL group orders the four callers pass:
//
//   components/ResultForm.tsx        → BIOMARKER_GROUP_LABELS, in declaration order
//   app/(app)/training/GoalForm.tsx  → the same three, via goal-target-options
//   components/SaveTrendKeyPicker.tsx → SERIES_PICKER_GROUP_ORDER
//   components/CompareControls.tsx    → the same, with an ungrouped "— none —" first
describe("the shipped grouped pickers, before and after", () => {
  const DUE = BIOMARKER_GROUP_LABELS["due-relevant"];
  const YOURS = BIOMARKER_GROUP_LABELS["your-markers"];
  const ALL = BIOMARKER_GROUP_LABELS["all-biomarkers"];
  const METRICS = SERIES_PICKER_METRICS_GROUP;
  const NONE = "— none —";

  // Build a picker's option array from a per-group count, in the caller's group
  // order, and tally what each rule shows. `main` is the flat cap this PR replaces.
  function tally(
    order: readonly string[],
    counts: Record<string, number>
  ): { main: Record<string, number>; view: Record<string, number> } {
    const options: string[] = [];
    const group = new Map<string, string | null>();
    for (const g of order) {
      if (g === NONE) {
        options.push(NONE);
        group.set(NONE, null);
        continue;
      }
      for (const option of named(g, counts[g] ?? 0)) {
        options.push(option);
        group.set(option, g);
      }
    }
    const count = (rows: readonly string[]) => {
      const out: Record<string, number> = {};
      for (const g of order) out[g] = 0;
      for (const row of rows) out[row === NONE ? NONE : group.get(row)!]++;
      return out;
    };
    return {
      main: count(options.slice(0, ROWS)),
      view: count(
        groupedRelevanceView(options, (o) => group.get(o) ?? null, ROWS).rows
      ),
    };
  }

  const RECORD_FORM = [DUE, YOURS, ALL];
  const STAR_PICKER = [DUE, METRICS, YOURS, ALL];
  const COMPARE = [NONE, DUE, METRICS, YOURS, ALL];
  // Enough to overflow the eight rows on their own, which is the real shape: the
  // canonical vocabulary is ~200 names and the standard metrics are a dozen.
  const BODY = { [ALL]: 200, [METRICS]: 12 };

  it("leaves the record form's shipped shape byte-identical", () => {
    // Two due-or-flagged analytes, one of the profile's own. This is the shape the
    // e2e fixture drives and the one the picker has today.
    const { main, view } = tally(RECORD_FORM, {
      [DUE]: 2,
      [YOURS]: 1,
      ...BODY,
    });
    expect(view).toEqual(main);
    expect(view).toEqual({ [DUE]: 2, [YOURS]: 1, [ALL]: 5 });
  });

  it("costs the record form TWO of its eight once a full panel fills every group", () => {
    // The realistic full-panel case: eight due-or-flagged AND at least one marker of
    // the profile's own, which `measured ∪ starred` gives any profile with results.
    // The one-row-per-group floor is spent twice here, once for each group behind
    // the leader — which is the bound, not an exception to it.
    expect(tally(RECORD_FORM, { [DUE]: 8, [YOURS]: 1, ...BODY }).main).toEqual({
      [DUE]: 8,
      [YOURS]: 0,
      [ALL]: 0,
    });
    expect(tally(RECORD_FORM, { [DUE]: 8, [YOURS]: 1, ...BODY }).view).toEqual({
      [DUE]: 6,
      [YOURS]: 1,
      [ALL]: 1,
    });
    // With no marker of its own there is one fewer group, so it costs one.
    expect(tally(RECORD_FORM, { [DUE]: 8, [YOURS]: 0, ...BODY }).view).toEqual({
      [DUE]: 7,
      [YOURS]: 0,
      [ALL]: 1,
    });
  });

  it("changes BOTH Trends pickers at every shape, which is the bug being fixed", () => {
    // The metrics and the ~200-name canonical body are always there, so these
    // pickers always have at least two groups — and before this change the body
    // never appeared at all until the user typed. There is no shape where they are
    // unchanged, and that is the #3410 defect, not a side effect of it.
    for (const due of [0, 3, 8]) {
      for (const yours of [0, 2]) {
        const star = tally(STAR_PICKER, {
          [DUE]: due,
          [YOURS]: yours,
          ...BODY,
        });
        expect(star.main[ALL], `star due=${due} yours=${yours}`).toBe(0);
        expect(star.view[ALL], `star due=${due} yours=${yours}`).toBe(1);

        const compare = tally(COMPARE, { [DUE]: due, [YOURS]: yours, ...BODY });
        expect(compare.main[ALL], `compare due=${due} yours=${yours}`).toBe(0);
        expect(compare.view[ALL], `compare due=${due} yours=${yours}`).toBe(1);
        // The clear row is first in the array and keeps its place either way.
        expect(compare.view[NONE]).toBe(1);
      }
    }
  });

  // THE OBJECTION, AND WHY IT REVERSES. `lib/series-picker-options.ts` puts Metrics
  // ahead of the biomarker body BECAUSE they are "the only way back after unstarring
  // a metric tile" — so the floor rule looks like it taxes a recovery affordance to
  // buy a header. At small due counts it does cost Metrics rows. At the counts where
  // the affordance actually matters it does the OPPOSITE: the flat cap let a busy
  // panel push Metrics off the pre-typing list ENTIRELY, and the floor is what makes
  // that impossible. This is why the group order was not changed to protect them —
  // it is already protected, and moving Metrics ahead of "Due or flagged" would bury
  // the bucket #1675 exists to surface.
  it("guarantees the metric rows a busy panel used to push off the list", () => {
    for (const order of [STAR_PICKER, COMPARE]) {
      const { main, view } = tally(order, { [DUE]: 8, [YOURS]: 2, ...BODY });
      // Before: a profile with eight due-or-flagged analytes saw NO metric row and
      // no Metrics header until it typed.
      expect(main[METRICS]).toBe(0);
      // After: a row and therefore a header, guaranteed, for every group present.
      expect(view[METRICS]).toBe(1);
    }
  });
});
