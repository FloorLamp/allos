// SERVER-ACTION TIER — the reprocess-with-preview APPLY path (issue #946).
//
// The reprocess preview used to extract, and the confirmed apply re-extracted a
// SECOND, possibly-different result — 2× spend and consent drift (the user approves
// one diff, the app commits another). The fix caches the preview's PersistInput under
// a single-use token; the apply commits EXACTLY that input with no re-extraction, and
// degrades to a fresh re-extract (with a typed `re-extracted` outcome the UI notes)
// when the token is missing/expired/stale.
//
// This drives the REAL server actions (previewReprocess + applyReprocessPreview)
// through the mocked auth boundary and asserts the typed outcome DISTINGUISHES a
// committed preview from a re-extracted fallback — the seam the UI's fallback note
// keys on.

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

// Stub only the extractor — everything else in medical-extract stays real.
vi.mock("@/lib/medical-extract", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/medical-extract")>();
  return { ...actual, extractMedicalDocument: vi.fn() };
});

import { db } from "@/lib/db";
import { seedActor, fd } from "./harness";
import { extractMedicalDocument } from "@/lib/medical-extract";
import type { ExtractionResult } from "@/lib/medical-extract";
import { _resetPreviewCache } from "@/lib/reprocess-preview-cache";
import {
  previewReprocess,
  applyReprocessPreview,
} from "@/app/(app)/medical/document-actions";

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

describe("applyReprocessPreview typed outcome (#946)", () => {
  it("commits the previewed extraction (committed-preview) and does not re-extract", async () => {
    const { profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());

    const preview = await previewReprocess(fd({ id: docId }));
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") return;
    expect(extractMock).toHaveBeenCalledTimes(1);

    const outcome = await applyReprocessPreview(
      fd({ id: docId, previewToken: preview.previewToken })
    );
    expect(outcome).toEqual({ mode: "committed-preview" });
    // The apply added no extractor call — exactly one across the whole flow.
    expect(extractMock).toHaveBeenCalledTimes(1);
    const names = (
      db
        .prepare(
          "SELECT name FROM medical_records WHERE profile_id = ? AND document_id = ?"
        )
        .all(profile.id, docId) as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(["Glucose"]);
  });

  it("falls back to re-extract (re-extracted) when no token is supplied", async () => {
    const { profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());

    // Preview so a cache entry exists, but apply WITHOUT the token — the apply must
    // not silently commit the cached input; it re-extracts and says so.
    await previewReprocess(fd({ id: docId }));
    const outcome = await applyReprocessPreview(fd({ id: docId }));
    expect(outcome).toEqual({ mode: "re-extracted" });
  });

  it("falls back (re-extracted) when the document changed since the preview", async () => {
    const { profile } = seedActor();
    const docId = insertDoc(profile.id);
    extractMock.mockResolvedValue(doneResult());

    const preview = await previewReprocess(fd({ id: docId }));
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") return;
    db.prepare(
      "UPDATE medical_documents SET content_hash = 'changed' WHERE id = ? AND profile_id = ?"
    ).run(docId, profile.id);

    const outcome = await applyReprocessPreview(
      fd({ id: docId, previewToken: preview.previewToken })
    );
    expect(outcome).toEqual({ mode: "re-extracted" });
  });
});
