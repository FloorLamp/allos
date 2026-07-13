// DB INTEGRATION TIER (npm run test:db) — issue #632.
//
// The document-import post-hook must thread the acting login into the
// recommendation run, so the regenerated daily insight formats weights/distances
// in the reader's unit preference instead of the canonical kg/km fallback. Before
// the fix, runExtraction had no loginId and called runRecommendation without one,
// so a lb/mi reader's freshly-regenerated insight silently rendered in kg.
//
// This drives the REAL runExtraction (with a stubbed extractor so no AI/network is
// needed) and asserts the loginId it was handed reaches the runRecommendation call
// verbatim, matching the scheduled first-page-view trigger.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { seedActor } from "@/lib/__action_tests__/harness";
import type { ExtractionResult } from "@/lib/medical-extract";

// Stub the extractor so runExtraction gets a deterministic `done` result with one
// biomarker — no AI key, no network. Everything else in medical-extract is real.
vi.mock("@/lib/medical-extract", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/medical-extract")>();
  return {
    ...actual,
    extractMedicalDocument: vi.fn(),
  };
});

// Spy the recommendation run — the assertion target. It's fire-and-forget, so a
// resolved stub is enough; we only care what runExtraction passes it.
vi.mock("@/lib/recommendation-engine", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/recommendation-engine")>();
  return {
    ...actual,
    runRecommendation: vi.fn(async () => ""),
  };
});

import { runExtraction } from "@/lib/medical-pipeline";
import { extractMedicalDocument } from "@/lib/medical-extract";
import { runRecommendation } from "@/lib/recommendation-engine";

const extractMock = vi.mocked(extractMedicalDocument);
const runRecommendationMock = vi.mocked(runRecommendation);

function doneResult(): Extract<ExtractionResult, { status: "done" }> {
  return {
    status: "done",
    meta: {
      document_type: "lab",
      source: null,
      patient_name: null,
      patient_sex: null,
      patient_birthdate: null,
      patient_age: null,
      document_date: "2026-07-01",
    },
    results: [
      {
        category: "lab",
        panel: null,
        name: "Glucose",
        canonical_name: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        reference_range: "70-99",
        flag: null,
        collected_date: "2026-07-01",
        notes: null,
      },
    ],
    immunizations: [],
    conditions: [],
    allergies: [],
    procedures: [],
    encounters: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    drops: [],
    model: "test-model",
    raw: "{}",
  };
}

function insertDoc(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, mime_type, extraction_status)
         VALUES (?, 'labs.pdf', 'data/uploads/medical/x/labs.pdf', 'application/pdf', 'processing')`
      )
      .run(profileId).lastInsertRowid
  );
}

beforeEach(() => {
  extractMock.mockReset();
  runRecommendationMock.mockClear();
  extractMock.mockResolvedValue(doneResult());
});

describe("runExtraction threads loginId into the recommendation run (issue #632)", () => {
  it("passes the acting login through to runRecommendation", async () => {
    const { login, profile } = seedActor();
    const docId = insertDoc(profile.id);

    const status = await runExtraction(
      profile.id,
      docId,
      Buffer.from("pdf"),
      "application/pdf",
      "labs.pdf",
      false,
      login.id
    );

    expect(status).toBe("done");
    expect(runRecommendationMock).toHaveBeenCalledWith(
      profile.id,
      expect.objectContaining({
        trigger: "document-imported",
        loginId: login.id,
      })
    );
  });

  it("passes loginId=undefined when no acting login is supplied (background context)", async () => {
    const { profile } = seedActor();
    const docId = insertDoc(profile.id);

    await runExtraction(
      profile.id,
      docId,
      Buffer.from("pdf"),
      "application/pdf",
      "labs.pdf",
      false
      // no loginId
    );

    expect(runRecommendationMock).toHaveBeenCalledWith(
      profile.id,
      expect.objectContaining({
        trigger: "document-imported",
        loginId: undefined,
      })
    );
  });
});
