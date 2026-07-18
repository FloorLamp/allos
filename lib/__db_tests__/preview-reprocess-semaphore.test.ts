// DB INTEGRATION TIER (npm run test:db) — issue #611.
//
// The reprocess-PREVIEW path (`previewReprocessById` → `extractPersistInputForPreview`)
// makes a real Claude extraction call, so it must behave like every other extraction
// dispatch: route through the process-wide concurrency limiter (`extractionSemaphore`,
// #135 item 2) and REFUND the charged daily-quota unit on a transient failure /
// saturated queue (#135 item 3). Before the fix the preview called the extractor
// directly (unbounded concurrency) and never refunded, so a rate-limited burst
// permanently consumed the profile's extraction cap with nothing imported.
//
// This drives the REAL previewReprocessById with a stubbed extractor (no AI key needed
// past aiConfigured(), no network) and asserts the semaphore acquisition + the
// charge/refund accounting matches runExtraction: a `done` preview keeps its charge, a
// `failed` extraction refunds, and a QueueFullError previews as a skip with a refund.

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { seedActor } from "@/lib/__action_tests__/harness";
import type { ExtractionResult } from "@/lib/medical-extract";

// Stub only the extractor — everything else in medical-extract stays real.
vi.mock("@/lib/medical-extract", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/medical-extract")>();
  return { ...actual, extractMedicalDocument: vi.fn() };
});

import {
  previewReprocessById,
  reprocessDocumentById,
} from "@/lib/medical-pipeline";
import { extractMedicalDocument } from "@/lib/medical-extract";
import { extractionSemaphore, QueueFullError } from "@/lib/ai-concurrency";
import { getAiUsageCount } from "@/lib/ai-usage";
import { _resetPreviewCache } from "@/lib/reprocess-preview-cache";

const extractMock = vi.mocked(extractMedicalDocument);

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

// A stored file on disk (plain text → not a health record → the AI path) whose
// stored_path resolves relative to process.cwd(), as previewReprocessById reads it.
const REL_DIR = "data/__preview_test__";
const REL_PATH = `${REL_DIR}/preview.txt`;

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
  // aiConfigured() must be true so the preview reaches the AI path; the extractor
  // itself is mocked, so no real key/network is used.
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  fs.mkdirSync(path.join(process.cwd(), REL_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), REL_PATH),
    "Preview test document — not a health record."
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

function importedRecordNames(profileId: number, docId: number): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM medical_records WHERE profile_id = ? AND document_id = ? ORDER BY name"
      )
      .all(profileId, docId) as { name: string }[]
  ).map((r) => r.name);
}

// The apply-commits-the-previewed-extraction contract (#946): the confirmed apply
// must persist EXACTLY what the preview extracted, extracting zero additional times,
// and the token is single-use, stale-guarded, and profile-scoped.
describe("apply commits the previewed extraction (#946)", () => {
  it("commits the previewed input with NO second extraction, and refuses the token twice", async () => {
    const { login, profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());

    const preview = await previewReprocessById(login.id, profile.id, docId);
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") return; // narrow for TS
    expect(preview.previewToken).toBeTruthy();
    // The preview ran the extractor exactly once.
    expect(extractMock).toHaveBeenCalledTimes(1);

    // Apply with the token: commits the cached input, no re-extraction.
    const outcome = reprocessDocumentById(
      login.id,
      profile.id,
      docId,
      preview.previewToken
    );
    expect(outcome).toEqual({ mode: "committed-preview" });
    // EXACTLY once total across preview + apply — the apply added no extractor call.
    // (One extraction ⇒ one ai-log event, satisfying the "one event per flow" bar.)
    expect(extractMock).toHaveBeenCalledTimes(1);
    // The persisted rows are the previewed extraction's rows.
    expect(importedRecordNames(profile.id, docId)).toEqual(["Glucose"]);

    // A second apply with the SAME token is refused (single-use) and falls back.
    const second = reprocessDocumentById(
      login.id,
      profile.id,
      docId,
      preview.previewToken
    );
    expect(second).toEqual({ mode: "re-extracted" });
  });

  it("falls back to a re-extract when the document changed since the preview (staleness)", async () => {
    const { login, profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());

    const preview = await previewReprocessById(login.id, profile.id, docId);
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") return;

    // Simulate a concurrent reprocess / replaced file: the row's content_hash moves.
    db.prepare(
      "UPDATE medical_documents SET content_hash = 'changed-since-preview' WHERE id = ? AND profile_id = ?"
    ).run(docId, profile.id);

    const outcome = reprocessDocumentById(
      login.id,
      profile.id,
      docId,
      preview.previewToken
    );
    expect(outcome).toEqual({ mode: "re-extracted" });
  });

  it("falls back once the preview token's TTL has expired", async () => {
    const { login, profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());

    const base = 1_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    const preview = await previewReprocessById(login.id, profile.id, docId);
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") {
      nowSpy.mockRestore();
      return;
    }
    // Jump past the ~15-minute TTL before applying.
    nowSpy.mockReturnValue(base + 16 * 60 * 1000);
    const outcome = reprocessDocumentById(
      login.id,
      profile.id,
      docId,
      preview.previewToken
    );
    nowSpy.mockRestore();
    expect(outcome).toEqual({ mode: "re-extracted" });
  });

  it("a token minted for profile A is useless for profile B (cross-profile)", async () => {
    const a = seedActor();
    const b = seedActor();
    const docId = insertDoc(a.profile.id);
    extractMock.mockResolvedValue(doneResult());

    const preview = await previewReprocessById(a.login.id, a.profile.id, docId);
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") return;

    // B applies A's token against A's document id — refused (the entry is A's).
    const asB = reprocessDocumentById(
      b.login.id,
      b.profile.id,
      docId,
      preview.previewToken
    );
    expect(asB).toEqual({ mode: "re-extracted" });
    // B's attempt did NOT consume A's entry — A can still commit its own preview.
    const asA = reprocessDocumentById(
      a.login.id,
      a.profile.id,
      docId,
      preview.previewToken
    );
    expect(asA).toEqual({ mode: "committed-preview" });
    expect(importedRecordNames(a.profile.id, docId)).toEqual(["Glucose"]);
  });
});

describe("previewReprocessById routes through the extraction semaphore (#611)", () => {
  it("acquires the semaphore and keeps the charge on a successful preview", async () => {
    const { login, profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());
    const runSpy = vi.spyOn(extractionSemaphore, "run");
    const before = getAiUsageCount(profile.id, "extraction");

    const res = await previewReprocessById(login.id, profile.id, docId);

    expect(res.status).toBe("ok");
    expect(runSpy).toHaveBeenCalledTimes(1);
    // A successful (done) extraction legitimately consumes one unit — no refund.
    expect(getAiUsageCount(profile.id, "extraction")).toBe(before + 1);
    runSpy.mockRestore();
  });

  it("refunds the charged unit when the extraction fails (transient)", async () => {
    const { login, profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue({
      status: "failed",
      error: "429 rate limited",
    } as ExtractionResult);
    const before = getAiUsageCount(profile.id, "extraction");

    const res = await previewReprocessById(login.id, profile.id, docId);

    expect(res.status).toBe("skipped");
    // Charged then refunded → the day's counter lands exactly where it started.
    expect(getAiUsageCount(profile.id, "extraction")).toBe(before);
  });

  it("previews a saturated queue as a skip with a refund (QueueFullError)", async () => {
    const { login, profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());
    const runSpy = vi
      .spyOn(extractionSemaphore, "run")
      .mockRejectedValue(new QueueFullError(100));
    const before = getAiUsageCount(profile.id, "extraction");

    const res = await previewReprocessById(login.id, profile.id, docId);

    expect(res.status).toBe("skipped");
    // The shed job refunds its charged unit — no permanent quota burn.
    expect(getAiUsageCount(profile.id, "extraction")).toBe(before);
    // The extractor was never invoked (the queue shed the job before the call).
    expect(extractMock).not.toHaveBeenCalled();
    runSpy.mockRestore();
  });
});
