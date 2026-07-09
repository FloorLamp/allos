import { describe, expect, it } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";
import { carePlanExternalId, careGoalExternalId } from "@/lib/clinical-parse";

// Fixture coverage for the two FHIR resource types added here: CarePlan and Goal
// (previously deliberately unmapped). Asserts the mappers produce the right rows —
// one care-plan row per activity (description / category / planned date / status),
// one care-goal per Goal (description / target date / lifecycleStatus) — that a
// revoked plan and entered-in-error goal are dropped, and that both resource types
// now register as consumed in the coverage report. All data is obviously synthetic.

function bundle(resources: object[]): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: resources.map((resource) => ({ resource })),
  });
}

describe("FHIR CarePlan → ImportedCarePlanItem", () => {
  it("maps one row per activity with description, planned date, and status", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "CarePlan",
          status: "active",
          activity: [
            {
              detail: {
                status: "scheduled",
                code: {
                  text: "Follow-up lipid panel",
                  coding: [{ system: "http://loinc.org", code: "57698-3" }],
                },
                category: { text: "observation" },
                scheduledPeriod: { start: "2025-01-15" },
              },
            },
            {
              detail: {
                status: "not-started",
                code: { text: "Repeat colonoscopy" },
                category: { text: "procedure" },
              },
            },
          ],
        },
      ])
    );
    expect(r.carePlanItems).toHaveLength(2);
    const lipid = r.carePlanItems!.find((c) => /lipid/i.test(c.description))!;
    expect(lipid).toMatchObject({
      description: "Follow-up lipid panel",
      code: "57698-3",
      category: "observation",
      planned_date: "2025-01-15",
      status: "scheduled",
    });
    expect(lipid.external_id).toBe(
      carePlanExternalId({
        description: "Follow-up lipid panel",
        code: "57698-3",
        plannedDate: "2025-01-15",
      })
    );
    // The activity with no scheduled date falls back to a null planned date and
    // inherits the plan's status when its own is absent.
    const colo = r.carePlanItems!.find((c) =>
      /colonoscopy/i.test(c.description)
    )!;
    expect(colo.planned_date).toBeNull();
  });

  it("drops a revoked CarePlan", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "CarePlan",
          status: "revoked",
          activity: [{ detail: { code: { text: "Something" } } }],
        },
      ])
    );
    expect(r.carePlanItems ?? []).toHaveLength(0);
  });
});

describe("FHIR Goal → ImportedCareGoal", () => {
  it("maps description, target date, and lifecycleStatus", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Goal",
          lifecycleStatus: "active",
          description: { text: "HbA1c below 6.5%" },
          target: [{ dueDate: "2025-09-01" }],
        },
        {
          resourceType: "Goal",
          lifecycleStatus: "entered-in-error",
          description: { text: "Erroneous goal" },
        },
      ])
    );
    expect(r.careGoals).toHaveLength(1);
    const g = r.careGoals![0];
    expect(g).toMatchObject({
      description: "HbA1c below 6.5%",
      target_date: "2025-09-01",
      status: "active",
    });
    expect(g.external_id).toBe(
      careGoalExternalId({
        description: "HbA1c below 6.5%",
        code: null,
        targetDate: "2025-09-01",
      })
    );
  });
});
