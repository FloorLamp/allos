import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import fs from "fs";
import path from "path";

// Stub only the extractor — everything else in medical-extract stays real.
vi.mock("@/lib/medical-extract", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/medical-extract")>();
  return { ...actual, extractMedicalDocument: vi.fn() };
});

// A configured key also enables the fire-and-forget post-import recommendation.
// Keep that separate AI feature from outliving these import-action tests.
vi.mock("@/lib/recommendation-engine", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/recommendation-engine")>();
  return { ...actual, runRecommendation: vi.fn(async () => "") };
});

import { db } from "@/lib/db";
import { seedActor, actAs, fd } from "./harness";
import { extractMedicalDocument } from "@/lib/medical-extract";
import type { ExtractionResult } from "@/lib/medical-extract";
import { _resetPreviewCache } from "@/lib/reprocess-preview-cache";
import {
  previewReprocess,
  applyReprocessPreview,
} from "@/app/(app)/medical/document-actions";

import { extractionSemaphore } from "@/lib/ai-concurrency";

const extractMock = vi.mocked(extractMedicalDocument);

function doneResult(value = 95): Extract<ExtractionResult, { status: "done" }> {
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
        value: String(value),
        value_num: value,
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

const REL_DIR = "data/__reprocess_apply_test__";
const REL_PATH = `${REL_DIR}/apply.txt`;

function insertDoc(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, mime_type, extraction_status)
         VALUES (?, 'labs.txt', ?, 'text/plain', 'done')`
      )
      .run(profileId, REL_PATH).lastInsertRowid
  );
}

let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  fs.mkdirSync(path.join(process.cwd(), REL_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), REL_PATH),
    "Apply test document — not a health record."
  );
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  fs.rmSync(path.join(process.cwd(), REL_DIR), {
    recursive: true,
    force: true,
  });
});

beforeEach(() => {
  extractMock.mockReset();
  _resetPreviewCache();
});

async function settleExtractions() {
  await vi.waitFor(() => {
    expect(extractionSemaphore.inUse).toBe(0);
    expect(extractionSemaphore.waiting).toBe(0);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  await settleExtractions();
  vi.restoreAllMocks();
});

function importedValues(profileId: number, docId: number) {
  return db
    .prepare(
      "SELECT value_num FROM medical_records WHERE profile_id = ? AND document_id = ?"
    )
    .all(profileId, docId);
}

async function preview(docId: number) {
  const result = await previewReprocess(fd({ id: docId }));
  if (result.status !== "ok") throw new Error(result.message);
  return result.previewToken;
}

describe("applyReprocessPreview", () => {
  it("commits the reviewed input once and refuses replay without another extraction", async () => {
    const { profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());
    const token = await preview(docId);
    extractMock.mockResolvedValue(doneResult(120));

    expect(
      await applyReprocessPreview(fd({ id: docId, previewToken: token }))
    ).toEqual({ mode: "committed-preview" });
    const replay = await applyReprocessPreview(
      fd({ id: docId, previewToken: token })
    );
    await settleExtractions();
    expect(replay.mode).toBe("refused");
    expect(importedValues(profile.id, docId)).toEqual([{ value_num: 95 }]);
    expect(extractMock).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "changed", "missing", "cache lost", "processing"])(
    "%s preview preserves existing records without another extraction",
    async (reason) => {
      const { profile } = seedActor();
      const docId = insertDoc(profile.id);
      extractMock.mockResolvedValue(doneResult());
      await applyReprocessPreview(
        fd({ id: docId, previewToken: await preview(docId) })
      );
      extractMock.mockResolvedValue(doneResult(120));
      const token = await preview(docId);
      extractMock.mockResolvedValue(doneResult(130));
      const before = db
        .prepare(
          "SELECT extraction_status FROM medical_documents WHERE id = ? AND profile_id = ?"
        )
        .get(docId, profile.id);
      if (reason === "expired")
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
      if (reason === "changed")
        db.prepare(
          "UPDATE medical_documents SET content_hash = 'changed' WHERE id = ? AND profile_id = ?"
        ).run(docId, profile.id);
      if (reason === "cache lost") _resetPreviewCache();
      if (reason === "processing")
        db.prepare(
          "UPDATE medical_documents SET extraction_status = 'processing' WHERE id = ? AND profile_id = ?"
        ).run(docId, profile.id);
      const outcome = await applyReprocessPreview(
        fd({
          id: docId,
          previewToken: reason === "missing" ? undefined : token,
        })
      );
      await settleExtractions();
      expect(outcome.mode).toBe("refused");
      expect(importedValues(profile.id, docId)).toEqual([{ value_num: 95 }]);
      expect(extractMock).toHaveBeenCalledTimes(2);
      expect(
        db
          .prepare(
            "SELECT extraction_status FROM medical_documents WHERE id = ? AND profile_id = ?"
          )
          .get(docId, profile.id)
      ).toEqual(
        reason === "processing" ? { extraction_status: "processing" } : before
      );
    }
  );

  it("a changed acting profile cannot consume the owner's preview", async () => {
    const owner = seedActor();
    const docId = insertDoc(owner.profile.id);
    extractMock.mockResolvedValue(doneResult());
    const token = await preview(docId);
    const other = seedActor();
    const otherDocId = insertDoc(other.profile.id);
    expect(
      (await applyReprocessPreview(fd({ id: otherDocId, previewToken: token })))
        .mode
    ).toBe("refused");
    expect(
      (await applyReprocessPreview(fd({ id: docId, previewToken: token }))).mode
    ).toBe("refused");
    actAs(owner.login, owner.profile);
    expect(
      await applyReprocessPreview(fd({ id: docId, previewToken: token }))
    ).toEqual({ mode: "committed-preview" });
    expect(importedValues(owner.profile.id, docId)).toEqual([
      { value_num: 95 },
    ]);
    expect(importedValues(other.profile.id, otherDocId)).toEqual([]);
    expect(extractMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failed preview commit without starting a second extraction", async () => {
    const { profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());
    const token = await preview(docId);
    db.prepare(
      "CREATE TEMP TRIGGER refuse_preview BEFORE INSERT ON medical_records BEGIN SELECT RAISE(ABORT, 'synthetic persist failure'); END"
    ).run();
    try {
      const outcome = await applyReprocessPreview(
        fd({ id: docId, previewToken: token })
      );
      expect(outcome.mode).toBe("refused");
      expect(importedValues(profile.id, docId)).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT extraction_status FROM medical_documents WHERE id = ? AND profile_id = ?"
          )
          .get(docId, profile.id)
      ).toEqual({ extraction_status: "failed" });
      expect(extractMock).toHaveBeenCalledTimes(1);
    } finally {
      db.prepare("DROP TRIGGER refuse_preview").run();
    }
  });

  it("only an explicit re-extract request runs a fresh extraction", async () => {
    const { profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());
    await preview(docId);
    extractMock.mockResolvedValue(doneResult(120));
    expect(
      await applyReprocessPreview(fd({ id: docId, force: "true" }))
    ).toEqual({ mode: "re-extracted" });
    await settleExtractions();
    expect(importedValues(profile.id, docId)).toEqual([{ value_num: 120 }]);
    expect(extractMock).toHaveBeenCalledTimes(2);
  });
});
