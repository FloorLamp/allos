import { describe, it, expect } from "vitest";
import type { Finding } from "@/lib/findings";
import {
  TRAINING_FINDINGS_CAP,
  rollupTrainingFindings,
  summarizeMuscleNames,
} from "@/lib/training-findings-rollup";
import { muscleVolumeSignalKey } from "@/lib/muscle-volume-bands";
import { TRAINING_OBS_PREFIX } from "@/lib/training-observations";
import type { MuscleId } from "@/lib/lifts";

// #1496: Training → Overview folds the per-muscle volume-band findings (#742 — up to
// one per MuscleId, ~17 on a normal week) into ONE expandable rollup row and caps the
// list at three rows + "show all". RENDERING ONLY: every finding is carried through
// with its dedupeKey intact, so each row still dismisses item-wise on the shared bus.

const MONTH = "2026-07";

function volumeFinding(muscle: MuscleId): Finding {
  return {
    domain: "muscle-volume",
    dedupeKey: muscleVolumeSignalKey(muscle, MONTH),
    title: `${muscle} volume is light this week`,
    tone: "info",
  };
}

function obsFinding(key: string, title: string): Finding {
  return {
    domain: "training-obs",
    dedupeKey: `${TRAINING_OBS_PREFIX}${key}`,
    title,
    tone: "caution",
  };
}

describe("rollupTrainingFindings", () => {
  it("folds every per-muscle volume finding into ONE group row", () => {
    const findings = [
      volumeFinding("chest"),
      volumeFinding("quads"),
      volumeFinding("calves"),
      volumeFinding("biceps"),
    ];
    const r = rollupTrainingFindings(findings);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe("group");
    expect(r.grouped).toBe(4);
    expect(r.total).toBe(4);
  });

  it("summarizes the group by count and names the biggest offenders first", () => {
    const r = rollupTrainingFindings([
      volumeFinding("chest"),
      volumeFinding("quads"),
      volumeFinding("calves"),
      volumeFinding("biceps"),
      volumeFinding("abs"),
    ]);
    const row = r.rows[0];
    if (row.kind !== "group") throw new Error("expected a group row");
    expect(row.group.title).toBe("5 muscle groups under weekly target");
    // Engine order is preserved (largest shortfall first) and the summary names the
    // first three, then counts the rest.
    expect(row.group.detail).toBe("Chest, Quads, Calves and 2 more");
  });

  it("singularizes a lone muscle shortfall", () => {
    const r = rollupTrainingFindings([volumeFinding("calves")]);
    const row = r.rows[0];
    if (row.kind !== "group") throw new Error("expected a group row");
    expect(row.group.title).toBe("1 muscle group under weekly target");
    expect(row.group.detail).toBe("Calves");
  });

  it("carries the folded findings through UNCHANGED — same dedupeKeys, item-wise dismiss", () => {
    const findings = [
      volumeFinding("chest"),
      volumeFinding("quads"),
      volumeFinding("calves"),
    ];
    const r = rollupTrainingFindings(findings);
    const row = r.rows[0];
    if (row.kind !== "group") throw new Error("expected a group row");
    expect(row.group.items).toEqual(findings);
    expect(row.group.items.map((f) => f.dedupeKey)).toEqual([
      "muscle-volume:below:chest:2026-07",
      "muscle-volume:below:quads:2026-07",
      "muscle-volume:below:calves:2026-07",
    ]);
  });

  it("dismissing one member leaves the rollup with N−1 (the bus is untouched)", () => {
    const all = [
      volumeFinding("chest"),
      volumeFinding("quads"),
      volumeFinding("calves"),
    ];
    // What the page recomputes after a dismiss: activeFindings drops the suppressed
    // key, the rollup re-folds what is left.
    const after = all.filter(
      (f) => f.dedupeKey !== muscleVolumeSignalKey("quads", MONTH)
    );
    const r = rollupTrainingFindings(after);
    const row = r.rows[0];
    if (row.kind !== "group") throw new Error("expected a group row");
    expect(row.group.items).toHaveLength(2);
    expect(row.group.title).toBe("2 muscle groups under weekly target");
    expect(r.rows).toHaveLength(1); // the rollup survives
  });

  it("keeps non-muscle findings as individual rows, group first", () => {
    const plateau = obsFinding(
      "plateau:skullcrusher",
      "Skullcrusher plateaued"
    );
    const stale = obsFinding("stale:row", "Barbell Row has gone quiet");
    const r = rollupTrainingFindings([
      plateau,
      volumeFinding("chest"),
      stale,
      volumeFinding("quads"),
    ]);
    expect(r.rows.map((row) => row.kind)).toEqual([
      "group",
      "finding",
      "finding",
    ]);
    expect(r.rows[1]).toMatchObject({ kind: "finding", finding: plateau });
    expect(r.rows[2]).toMatchObject({ kind: "finding", finding: stale });
    expect(r.total).toBe(4);
    expect(r.grouped).toBe(2);
  });

  it("emits no group row when nothing volume-related fired", () => {
    const r = rollupTrainingFindings([
      obsFinding("balance:push-pull", "Push/pull"),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe("finding");
    expect(r.grouped).toBe(0);
  });

  it("caps the visible rows at three and overflows the rest", () => {
    expect(TRAINING_FINDINGS_CAP).toBe(3);
    const r = rollupTrainingFindings([
      volumeFinding("chest"),
      obsFinding("a", "A"),
      obsFinding("b", "B"),
      obsFinding("c", "C"),
      obsFinding("d", "D"),
    ]);
    expect(r.shown).toHaveLength(3);
    expect(r.overflow).toHaveLength(2);
    // The group leads, so a page full of individual observations can never push the
    // rollup into the hidden overflow.
    expect(r.shown[0].kind).toBe("group");
    expect(r.shown.concat(r.overflow)).toEqual(r.rows);
  });

  it("overflows nothing when the row count fits the cap", () => {
    const r = rollupTrainingFindings([
      obsFinding("a", "A"),
      obsFinding("b", "B"),
    ]);
    expect(r.shown).toHaveLength(2);
    expect(r.overflow).toHaveLength(0);
  });

  it("returns an empty model for no findings", () => {
    const r = rollupTrainingFindings([]);
    expect(r.rows).toEqual([]);
    expect(r.shown).toEqual([]);
    expect(r.overflow).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.grouped).toBe(0);
  });

  it("honors an explicit cap", () => {
    const r = rollupTrainingFindings(
      [obsFinding("a", "A"), obsFinding("b", "B"), obsFinding("c", "C")],
      1
    );
    expect(r.shown).toHaveLength(1);
    expect(r.overflow).toHaveLength(2);
  });
});

describe("summarizeMuscleNames", () => {
  it("lists up to the limit then counts the rest", () => {
    expect(summarizeMuscleNames(["Chest"])).toBe("Chest");
    expect(summarizeMuscleNames(["Chest", "Quads"])).toBe("Chest, Quads");
    expect(summarizeMuscleNames(["Chest", "Quads", "Calves"])).toBe(
      "Chest, Quads, Calves"
    );
    expect(summarizeMuscleNames(["Chest", "Quads", "Calves", "Abs"])).toBe(
      "Chest, Quads, Calves and 1 more"
    );
  });

  it("is empty for no names", () => {
    expect(summarizeMuscleNames([])).toBe("");
  });
});
