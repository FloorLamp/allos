import { describe, it, expect } from "vitest";
import {
  dentalFollowUpAdapter,
  dentalSourceLabel,
  dentalFollowUpTitle,
  findResolvingDentalRecord,
  dentalResolvingLabel,
  DENTAL_FOLLOWUP_KIND,
} from "@/lib/followup-dental";
import type { DentalProcedure } from "@/lib/types";

function rec(p: Partial<DentalProcedure>): DentalProcedure {
  return {
    id: 1,
    name: "Caries watch",
    status: "watch",
    tooth: "14",
    tooth_system: "universal",
    surface: null,
    cdt_code: null,
    procedure_date: "2026-03-01",
    finding: null,
    follow_up_interval_days: 180,
    provider_id: null,
    notes: null,
    source: null,
    document_id: null,
    external_id: null,
    created_at: "2026-03-01",
    ...p,
  };
}

describe("dental follow-up adapter (#705 ask 5)", () => {
  it("source label prefers the finding text, capped, with a YYYY-MM tail", () => {
    expect(
      dentalSourceLabel(
        rec({ finding: "watch mesial #14 for recurrent decay" })
      )
    ).toBe("watch mesial #14 for recurrent decay (2026-03)");
    // No finding → falls back to the display label.
    expect(dentalSourceLabel(rec({ finding: null }))).toBe(
      "Caries watch · #14 (2026-03)"
    );
  });

  it("follow-up title names the tooth when known", () => {
    expect(dentalFollowUpTitle(rec({ tooth: "14" }))).toBe(
      "Dental recheck #14"
    );
    expect(dentalFollowUpTitle(rec({ tooth: null }))).toBe("Dental recheck");
  });

  it("resolves against a LATER record on the SAME tooth", () => {
    const source = rec({ id: 1, tooth: "14", procedure_date: "2026-03-01" });
    const sameToothLater = rec({
      id: 2,
      name: "Composite filling",
      status: "completed",
      tooth: "14",
      procedure_date: "2026-09-01",
    });
    const otherTooth = rec({
      id: 3,
      tooth: "30",
      procedure_date: "2026-10-01",
    });
    const earlier = rec({ id: 4, tooth: "14", procedure_date: "2026-01-01" });
    const resolving = findResolvingDentalRecord(source, {} as never, [
      source,
      sameToothLater,
      otherTooth,
      earlier,
    ]);
    expect(resolving?.id).toBe(2);
    expect(dentalResolvingLabel(sameToothLater)).toBe(
      "Composite filling · #14 · 2026-09"
    );
  });

  it("returns null when no later same-tooth record exists", () => {
    const source = rec({ id: 1, tooth: "14", procedure_date: "2026-03-01" });
    const otherTooth = rec({
      id: 3,
      tooth: "30",
      procedure_date: "2026-10-01",
    });
    expect(
      findResolvingDentalRecord(source, {} as never, [source, otherTooth])
    ).toBeNull();
  });

  it("exposes the adapter shape with kind='dental'", () => {
    expect(dentalFollowUpAdapter.kind).toBe(DENTAL_FOLLOWUP_KIND);
    expect(DENTAL_FOLLOWUP_KIND).toBe("dental");
  });
});
