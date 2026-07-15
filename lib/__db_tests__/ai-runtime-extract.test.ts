// DB INTEGRATION TIER (npm run test:db) — issue #675.
//
// The extraction RUNTIME above the tested primitives: runExtraction / reprocessOne
// (lib/medical-pipeline.ts) driving the real orchestrator (lib/medical-extract/
// extract.ts) over CANNED model output. The Anthropic SDK is injected at the
// `lib/ai-client.ts` seam — `createAiClient()` is mocked to return a fake client
// whose messages.stream(...).finalMessage() resolves to a scripted message — so no
// network and no API key are used, and the real buildContent → tool-use parsing →
// normalize → persist → finalize path runs end to end. This is the gap the freshness
// map flagged: the cap/claim/reaper PRIMITIVES are covered, the orchestration between
// "document stored" and "records appear / failure surfaces" was not.
//
// Covers: (1) happy path — canned output lands normalized rows with document_id
// provenance, extracted_count tallied, status → done; (2) failure honesty — no
// structured data / truncation / a plain API error / a mapped APIError all mark the
// document 'failed' with the reason surfaced, commit NO partial rows, and refund the
// charged daily unit; (3) cap refusal — at the daily extraction limit reprocessOne
// REFUSES with the user-visible 'skipped' + limit message and never calls the model;
// (4) log context — an extraction wrapped in withAiLogContext lands a tagged ai.jsonl
// event, a background (unwrapped) one lands untagged.

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APIError } from "@anthropic-ai/sdk";

// Inject the SDK at the ai-client seam; everything else in the module stays real
// (aiConfigured reads process.env, which we set below). No production change — the
// factory is a named export used at call time, so vi.mock replaces it cleanly.
vi.mock("@/lib/ai-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai-client")>();
  return { ...actual, createAiClient: vi.fn() };
});

// The post-import auto-recommendation is a separate AI feature (its own tests);
// stub it so the extraction runtime under test is isolated and deterministic.
vi.mock("@/lib/recommendation-engine", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/recommendation-engine")>();
  return { ...actual, runRecommendation: vi.fn(async () => "") };
});

import { db, today } from "@/lib/db";
import { seedActor } from "@/lib/__action_tests__/harness";
import { createAiClient } from "@/lib/ai-client";
import { extractMedicalDocument } from "@/lib/medical-extract";
import { runExtraction, reprocessOne } from "@/lib/medical-pipeline";
import {
  checkAndIncrementAiUsage,
  getAiUsageCount,
  extractionDailyLimit,
} from "@/lib/ai-usage";
import {
  withAiLogContext,
  aiLogSize,
  tailAiLog,
  type AiEvent,
} from "@/lib/ai-log";
import { toolMessage, noToolMessage, fakeClient } from "./ai-fake-client";

const createAiClientMock = vi.mocked(createAiClient);

// A canonical single-analyte extraction payload the save_medical_data tool returns.
function labInput() {
  return {
    document_type: "lab",
    source: "Test Lab",
    patient_name: "Test Patient",
    patient_sex: "female",
    patient_birthdate: null,
    patient_age: null,
    document_date: "2026-07-01",
    results: [
      {
        category: "lab",
        panel: "Lipid Panel",
        name: "LDL CHOL., DIRECT",
        canonical_name: "LDL Cholesterol",
        value: "130",
        value_num: 130,
        unit: "mg/dL",
        reference_range: "<100",
        flag: "high",
        collected_date: "2026-07-01",
        notes: null,
        prescription: null,
      },
    ],
    immunizations: [],
    conditions: [],
    allergies: [],
    procedures: [],
    encounters: [],
    family_history: [],
    care_plan: [],
    care_goals: [],
    genomic_variants: [],
    imaging_studies: [],
  };
}

function insertProcessingDoc(
  profileId: number,
  storedPath = "x/doc.pdf"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, mime_type, extraction_status)
         VALUES (?, 'labs.pdf', ?, 'application/pdf', 'processing')`
      )
      .run(profileId, storedPath).lastInsertRowid
  );
}

function docRow(id: number) {
  return db
    .prepare(
      "SELECT extraction_status AS status, extraction_error AS error, extracted_count, stored_path FROM medical_documents WHERE id = ?"
    )
    .get(id) as {
    status: string;
    error: string | null;
    extracted_count: number | null;
    stored_path: string | null;
  };
}

function recordsForDoc(profileId: number, docId: number) {
  return db
    .prepare(
      "SELECT name, canonical_name, value_num, flag, document_id FROM medical_records WHERE profile_id = ? AND document_id = ?"
    )
    .all(profileId, docId) as {
    name: string;
    canonical_name: string | null;
    value_num: number | null;
    flag: string | null;
    document_id: number | null;
  }[];
}

let savedKey: string | undefined;
const TMP_REL = "data/__ai_runtime_test__";

beforeAll(() => {
  // aiConfigured() must be true so the runtime reaches the model dispatch; the
  // client itself is mocked, so no real key/network is used.
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  fs.mkdirSync(path.join(process.cwd(), TMP_REL), { recursive: true });
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  fs.rmSync(path.join(process.cwd(), TMP_REL), {
    recursive: true,
    force: true,
  });
});

beforeEach(() => {
  createAiClientMock.mockReset();
});

describe("runExtraction happy path (issue #675)", () => {
  it("imports canned model output as normalized rows with document_id provenance and flips to done", async () => {
    const { profile } = seedActor();
    const docId = insertProcessingDoc(profile.id);
    createAiClientMock.mockReturnValue(
      fakeClient(toolMessage("save_medical_data", labInput()))
    );

    const status = await runExtraction(
      profile.id,
      docId,
      Buffer.from("%PDF-1.4 fake"),
      "application/pdf",
      "labs.pdf",
      false
    );

    expect(status).toBe("done");
    const doc = docRow(docId);
    expect(doc.status).toBe("done");
    expect(doc.error).toBeNull();
    expect(doc.extracted_count).toBeGreaterThanOrEqual(1);

    // The row landed with its cleaned canonical name and value, carrying the
    // document_id back-reference (provenance) so a reprocess/delete can find it.
    const rows = recordsForDoc(profile.id, docId);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_name).toBe("LDL Cholesterol");
    expect(rows[0].value_num).toBe(130);
    expect(rows[0].document_id).toBe(docId);
    // extracted_count tallies the footprint the import wrote.
    expect(doc.extracted_count).toBe(rows.length);
  });

  it("keeps the charged daily unit on a successful (done) extraction", async () => {
    const { profile } = seedActor();
    const docId = insertProcessingDoc(profile.id);
    createAiClientMock.mockReturnValue(
      fakeClient(toolMessage("save_medical_data", labInput()))
    );
    // Simulate the dispatch having consumed one unit (charged=true).
    checkAndIncrementAiUsage(profile.id, "extraction", extractionDailyLimit());
    const before = getAiUsageCount(profile.id, "extraction");

    const status = await runExtraction(
      profile.id,
      docId,
      Buffer.from("%PDF-1.4 fake"),
      "application/pdf",
      "labs.pdf",
      true // charged
    );

    expect(status).toBe("done");
    // A successful extraction legitimately consumes the unit — no refund.
    expect(getAiUsageCount(profile.id, "extraction")).toBe(before);
  });
});

describe("runExtraction failure honesty (issue #675)", () => {
  type Case = {
    name: string;
    client: () => ReturnType<typeof fakeClient>;
    errorMatch: RegExp;
  };
  const cases: Case[] = [
    {
      name: "no structured data (model returned only prose)",
      client: () => fakeClient(noToolMessage()),
      errorMatch: /no structured data/i,
    },
    {
      name: "truncated at the output limit (stop_reason max_tokens)",
      client: () =>
        fakeClient(
          toolMessage("save_medical_data", labInput(), {
            stop_reason: "max_tokens",
          })
        ),
      errorMatch: /truncated/i,
    },
    {
      name: "a plain connection error from the SDK",
      client: () => fakeClient(new Error("connection reset")),
      errorMatch: /connection reset/i,
    },
    {
      name: "a mapped APIError (HTTP 429 rate limit)",
      client: () =>
        fakeClient(
          new APIError(429, { type: "error" }, "too many", new Headers())
        ),
      errorMatch: /rate limited/i,
    },
  ];

  for (const c of cases) {
    it(`marks the document failed, surfaces the reason, commits no rows, and refunds — ${c.name}`, async () => {
      const { profile } = seedActor();
      const docId = insertProcessingDoc(profile.id);
      createAiClientMock.mockReturnValue(c.client());
      // Charge a unit up front so we can pin the refund.
      checkAndIncrementAiUsage(
        profile.id,
        "extraction",
        extractionDailyLimit()
      );
      const charged = getAiUsageCount(profile.id, "extraction");
      expect(charged).toBe(1);

      const status = await runExtraction(
        profile.id,
        docId,
        Buffer.from("%PDF-1.4 fake"),
        "application/pdf",
        "labs.pdf",
        true // charged → transient failure refunds
      );

      expect(status).toBe("failed");
      const doc = docRow(docId);
      expect(doc.status).toBe("failed");
      expect(doc.error).toMatch(c.errorMatch);
      // The file is STILL stored — a failure never discards the upload.
      expect(doc.stored_path).toBe("x/doc.pdf");
      // Transactionality: NOT ONE partial row was committed for this document.
      expect(recordsForDoc(profile.id, docId)).toHaveLength(0);
      // The transient failure handed the charged unit back.
      expect(getAiUsageCount(profile.id, "extraction")).toBe(charged - 1);
    });
  }
});

describe("extraction cap refusal at the daily limit (issue #675)", () => {
  it("reprocessOne REFUSES with the user-visible skipped state and never calls the model", async () => {
    const { login, profile } = seedActor();
    // A stored plain-text file on disk (not a health record → the AI path).
    const rel = `${TMP_REL}/capped-${login.id}.txt`;
    fs.writeFileSync(
      path.join(process.cwd(), rel),
      "Some labs, not a health record."
    );
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents (profile_id, filename, stored_path, mime_type, extraction_status)
           VALUES (?, 'labs.txt', ?, 'text/plain', 'done')`
        )
        .run(profile.id, rel).lastInsertRowid
    );
    // Exhaust the profile's daily extraction quota.
    db.prepare(
      `INSERT INTO ai_usage_counters (profile_id, day, kind, count) VALUES (?, ?, 'extraction', ?)`
    ).run(profile.id, today(profile.id), extractionDailyLimit());

    const status = await reprocessOne(profile.id, docId, login.id);

    expect(status).toBe("skipped");
    const doc = docRow(docId);
    expect(doc.status).toBe("skipped");
    expect(doc.error).toMatch(/daily ai limit/i);
    // The refusal is silent to the model — it was never constructed/called.
    expect(createAiClientMock).not.toHaveBeenCalled();
  });
});

describe("ai-log context propagation (issue #675)", () => {
  function eventFor(events: AiEvent[], filename: string): AiEvent | undefined {
    return events.find(
      (e) =>
        e.feature === "extraction" &&
        e.status === "ok" &&
        (e.detail ?? "").includes(filename)
    );
  }

  it("tags the ai.jsonl event with the acting login/profile when wrapped, and leaves it null when not", async () => {
    const { login, profile } = seedActor();
    createAiClientMock.mockReturnValue(
      fakeClient(toolMessage("save_medical_data", labInput()))
    );

    const before = aiLogSize();
    const taggedName = `tagged-${login.id}-${Date.now()}.csv`;
    const bgName = `bg-${login.id}-${Date.now()}.csv`;

    // Wrapped: the ambient context propagates into the extractor's recordAiEvent.
    await withAiLogContext({ loginId: login.id, profileId: profile.id }, () =>
      extractMedicalDocument(
        Buffer.from("a,b\n1,2"),
        "text/csv",
        taggedName,
        []
      )
    );
    // Unwrapped background call: no ambient context → null tags.
    await extractMedicalDocument(
      Buffer.from("a,b\n1,2"),
      "text/csv",
      bgName,
      []
    );

    const { events } = tailAiLog(before);
    const tagged = eventFor(events, taggedName);
    const bg = eventFor(events, bgName);

    expect(tagged).toBeDefined();
    expect(tagged!.loginId).toBe(login.id);
    expect(tagged!.profileId).toBe(profile.id);

    expect(bg).toBeDefined();
    expect(bg!.loginId).toBeNull();
    expect(bg!.profileId).toBeNull();
  });
});
