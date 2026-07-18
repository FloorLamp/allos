import { describe, it, expect } from "vitest";
import {
  isIopBiomarker,
  iopReadingName,
  iopLateralityLabel,
  iopValueLabel,
  iopSourceLabel,
  iopFollowUpTitle,
  iopResolvingLabel,
  findResolvingIopReading,
  IOP_FOLLOWUP_TITLE,
  type IopFollowUpRecord,
} from "@/lib/followup-iop";
import type { FollowUpItemLike } from "@/lib/followup";

// The IOP (intraocular-pressure) adapter boundaries (issue #698 §6 / Part of #700),
// the eye-care sibling of the imaging + flagged-labs adapter pure tests. Pins the
// domain answers the core consumes: the bilateral "one question" identity (any eye is
// the same glaucoma follow-up — NOT the global biomarker family, so per-eye charts stay
// separate), the "flagged 28 mmHg, right eye (2026-05)" legibility label, the fixed
// glaucoma-workup title, and the "most-recent later IOP reading (either eye) resolves"
// rule.

function rec(over: Partial<IopFollowUpRecord> & { id: number }): IopFollowUpRecord {
  return {
    id: over.id,
    date: over.date ?? "2026-05-12",
    canonical_name: over.canonical_name ?? "Intraocular Pressure, Right Eye",
    name: over.name ?? "Intraocular Pressure, Right Eye",
    value: over.value === undefined ? "28" : over.value,
    unit: over.unit ?? "mmHg",
    value_num: over.value_num === undefined ? 28 : over.value_num,
    flag: over.flag ?? "high",
  };
}

const followUp: FollowUpItemLike = {
  id: 7,
  title: IOP_FOLLOWUP_TITLE,
  plannedDate: "2026-08-12",
  recommendedIntervalDays: 91,
  source: { kind: "iop", recordId: 1 },
  resolution: null,
};

describe("IOP adapter — identity", () => {
  it("recognizes IOP readings (any eye / generic / abbreviation), not lookalikes", () => {
    expect(isIopBiomarker("Intraocular Pressure")).toBe(true);
    expect(isIopBiomarker("Intraocular Pressure, Right Eye")).toBe(true);
    expect(isIopBiomarker("Intraocular Pressure, Left Eye")).toBe(true);
    expect(isIopBiomarker("IOP OD")).toBe(true);
    expect(isIopBiomarker("iop")).toBe(true);
    // NOT a loose substring — "biopsy" must not read as IOP.
    expect(isIopBiomarker("Skin biopsy")).toBe(false);
    expect(isIopBiomarker("LDL Cholesterol")).toBe(false);
    expect(isIopBiomarker("")).toBe(false);
  });

  it("recovers the eye from the reading name (laterality lives in the name)", () => {
    expect(iopLateralityLabel(rec({ id: 1 }))).toBe("right eye");
    expect(
      iopLateralityLabel(
        rec({ id: 1, canonical_name: "Intraocular Pressure, Left Eye" })
      )
    ).toBe("left eye");
    expect(
      iopLateralityLabel(
        rec({ id: 1, canonical_name: "Intraocular Pressure" })
      )
    ).toBe("");
  });
});

describe("IOP adapter — labels", () => {
  it("iopValueLabel composes value + mmHg (spaced), falling back to value_num", () => {
    expect(iopValueLabel(rec({ id: 1, value: "28", unit: "mmHg" }))).toBe(
      "28 mmHg"
    );
    expect(
      iopValueLabel(rec({ id: 1, value: null, value_num: 16, unit: "mmHg" }))
    ).toBe("16 mmHg");
  });

  it("iopSourceLabel names the flagged pressure, the eye, and the month (#656 reason)", () => {
    expect(
      iopSourceLabel(
        rec({ id: 1, value: "28", unit: "mmHg", date: "2026-05-12" })
      )
    ).toBe("flagged 28 mmHg, right eye (2026-05)");
    // Eye unspecified drops the laterality clause.
    expect(
      iopSourceLabel(
        rec({
          id: 1,
          canonical_name: "Intraocular Pressure",
          name: "Intraocular Pressure",
          value: "24",
          date: "2026-05-12",
        })
      )
    ).toBe("flagged 24 mmHg (2026-05)");
  });

  it("iopFollowUpTitle is the fixed bilateral glaucoma-workup title", () => {
    expect(iopFollowUpTitle(rec({ id: 1 }))).toBe(
      "Recheck IOP / glaucoma workup"
    );
    // Same title regardless of which eye seeded it (one bilateral question).
    expect(
      iopFollowUpTitle(
        rec({ id: 1, canonical_name: "Intraocular Pressure, Left Eye" })
      )
    ).toBe("Recheck IOP / glaucoma workup");
  });

  it("iopResolvingLabel is compact + eye + dated", () => {
    expect(
      iopResolvingLabel(
        rec({
          id: 2,
          canonical_name: "Intraocular Pressure, Left Eye",
          value: "16",
          date: "2026-08-20",
        })
      )
    ).toBe("16 mmHg, left eye · 2026-08");
  });
});

describe("IOP adapter — resolution matching (bilateral)", () => {
  it("resolves against a LATER IOP reading — the OTHER eye resolves too (one workup)", () => {
    const source = rec({
      id: 1,
      canonical_name: "Intraocular Pressure, Right Eye",
      date: "2026-05-12",
    });
    const laterLeft = rec({
      id: 2,
      canonical_name: "Intraocular Pressure, Left Eye",
      date: "2026-08-20",
      value: "17",
      value_num: 17,
      flag: "normal",
    });
    const laterLdl = rec({
      id: 3,
      canonical_name: "LDL Cholesterol",
      name: "LDL Cholesterol",
      date: "2026-09-01",
    });
    const earlierRight = rec({ id: 4, date: "2026-01-01" });
    const candidates = [source, laterLeft, laterLdl, earlierRight];
    // The later left-eye pressure resolves the right-eye follow-up (bilateral), not the
    // LDL (defensive isIop guard), not the earlier reading.
    expect(findResolvingIopReading(source, followUp, candidates)?.id).toBe(2);
  });

  it("returns null when only earlier or the source itself is present", () => {
    const source = rec({ id: 1, date: "2026-05-12" });
    expect(findResolvingIopReading(source, followUp, [source])).toBeNull();
    const earlier = rec({ id: 2, date: "2026-01-01" });
    expect(
      findResolvingIopReading(source, followUp, [source, earlier])
    ).toBeNull();
  });

  it("picks the MOST RECENT qualifying later reading", () => {
    const source = rec({ id: 1, date: "2026-01-01" });
    const a = rec({ id: 2, date: "2026-06-01" });
    const b = rec({ id: 3, date: "2027-06-01" });
    expect(findResolvingIopReading(source, followUp, [source, a, b])?.id).toBe(
      3
    );
  });
});

describe("IOP adapter — reading name", () => {
  it("prefers the canonical name, falls back to the raw name", () => {
    expect(iopReadingName(rec({ id: 1, canonical_name: "Intraocular Pressure" }))).toBe(
      "Intraocular Pressure"
    );
    expect(
      iopReadingName(rec({ id: 1, canonical_name: "  ", name: "IOP OD" }))
    ).toBe("IOP OD");
  });
});
