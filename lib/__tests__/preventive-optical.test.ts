import { describe, it, expect } from "vitest";
import {
  inferOpticalRxSatisfactions,
  type OpticalRxSatisfactionInput,
} from "@/lib/preventive-optical";

describe("inferOpticalRxSatisfactions (#1098)", () => {
  it("counts a dated optical Rx as satisfying vision_exam as of its issued date", () => {
    expect(
      inferOpticalRxSatisfactions([{ issued_date: "2026-03-14" }])
    ).toEqual([{ ruleKey: "vision_exam", date: "2026-03-14" }]);
  });

  it("uses the ISSUED date, not any expiry or import date, as the satisfaction date", () => {
    // An expired Rx still evidences the exam that produced it — expiry is irrelevant.
    expect(
      inferOpticalRxSatisfactions([
        { issued_date: "2021-01-05" } as OpticalRxSatisfactionInput,
      ])
    ).toEqual([{ ruleKey: "vision_exam", date: "2021-01-05" }]);
  });

  it("emits one satisfaction per dated Rx (the assessor takes the newest per rule)", () => {
    expect(
      inferOpticalRxSatisfactions([
        { issued_date: "2024-06-01" },
        { issued_date: "2026-06-01" },
      ])
    ).toEqual([
      { ruleKey: "vision_exam", date: "2024-06-01" },
      { ruleKey: "vision_exam", date: "2026-06-01" },
    ]);
  });

  it("truncates a datetime issued_date to YYYY-MM-DD", () => {
    expect(
      inferOpticalRxSatisfactions([{ issued_date: "2026-03-14T09:30:00Z" }])
    ).toEqual([{ ruleKey: "vision_exam", date: "2026-03-14" }]);
  });

  it("drops a Rx with no usable date (can't be placed on the cadence timeline)", () => {
    expect(
      inferOpticalRxSatisfactions([
        { issued_date: null },
        { issued_date: "" },
        { issued_date: "not-a-date" },
        { issued_date: undefined },
      ])
    ).toEqual([]);
  });

  it("returns nothing for no prescriptions (a no-Rx profile stays overdue)", () => {
    expect(inferOpticalRxSatisfactions([])).toEqual([]);
  });
});
