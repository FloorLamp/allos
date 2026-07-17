// DB INTEGRATION TIER (npm run test:db). Exercises the medical PIPELINE engine
// directly at the lib layer (lib/medical-pipeline.ts), which issue #318 split out
// of app/(app)/medical/actions.ts specifically so it is reachable here rather than
// only through the thin server actions. These cover the deterministic, synchronous
// pipeline outcomes (no AI key required); the AI dispatch is fire-and-forget and is
// covered end-to-end by the action/query tiers.
//
// The refactor is behavior-preserving, so these tests pin the observable contracts
// the actions used to own inline:
//   1. ingestMedicalUpload rejects an unsupported file → a 'failed' documents row,
//      scoped to the acting profile.
//   2. ingestMedicalUpload rejects an oversized file BEFORE buffering.
//   3. computeReprocessAllCost classifies the reprocessable set (read-only).
//   4. reprocessAllForProfile with nothing to run returns the no-op message.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ingestMedicalUpload,
  computeReprocessAllCost,
  reprocessAllForProfile,
  reprocessFromRawById,
} from "@/lib/medical-pipeline";
import { getAiUsageCount } from "@/lib/ai-usage";
import { seedActor } from "@/lib/__action_tests__/harness";

function docRows(profileId: number) {
  return db
    .prepare(
      "SELECT id, filename, extraction_status AS status, extraction_error AS error, stored_path FROM medical_documents WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as {
    id: number;
    filename: string;
    status: string;
    error: string | null;
    stored_path: string | null;
  }[];
}

describe("medical-pipeline: ingestMedicalUpload validation", () => {
  it("rejects an unsupported file type with a 'failed' row scoped to the profile", async () => {
    const { login, profile } = seedActor();
    const file = new File([Buffer.from("not a real document")], "notes.xyz", {
      type: "application/octet-stream",
    });
    await ingestMedicalUpload(login.id, profile.id, file);

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toBe("Unsupported file type.");
    // No file was stored for a rejected upload.
    expect(rows[0].stored_path === "" || rows[0].stored_path === null).toBe(
      true
    );

    // A second profile is untouched (profile scoping).
    const other = seedActor();
    expect(docRows(other.profile.id)).toHaveLength(0);
  });

  it("rejects an oversized file before buffering", async () => {
    const { login, profile } = seedActor();
    // A File larger than the 64MB absolute cap (MAX_HEALTH_BYTES), reported via
    // file.size. A ".pdf" carries no health-record pre-buffer signal, so the gate
    // caps it at the 32MB AI ceiling and rejects it without reading the body.
    const big = new File([Buffer.from("x")], "huge.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(big, "size", { value: 70 * 1024 * 1024 });
    await ingestMedicalUpload(login.id, profile.id, big);

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/too large/i);
  });

  it("rejects a large NON-health-signaled upload WITHOUT buffering its body (issue #695)", async () => {
    const { login, profile } = seedActor();
    // A 60MB ".pdf": no health-record extension/MIME signal, so the pre-buffer
    // gate caps it at the 32MB AI ceiling and must reject it BEFORE the whole body
    // is read into memory. Before #695 the gate admitted everything to 64MB and
    // buffered it, only rejecting afterward — doubling worst-case buffered memory.
    // We assert arrayBuffer() is never called.
    const file = new File([Buffer.from("x")], "notes.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "size", { value: 60 * 1024 * 1024 });
    let buffered = false;
    const realArrayBuffer = file.arrayBuffer.bind(file);
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => {
        buffered = true;
        return realArrayBuffer();
      },
    });
    await ingestMedicalUpload(login.id, profile.id, file);

    expect(buffered).toBe(false);
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/too large \(max 32MB\)/i);
  });

  it("still rejects a >32MB NON-health file (the Anthropic-bound AI cap)", async () => {
    const { login, profile } = seedActor();
    // A real 33MB PDF: over the 32MB AI cap (MAX_AI_BYTES). A ".pdf" carries no
    // health-record pre-buffer signal, so the pre-buffer gate now caps it at 32MB
    // and rejects it here (post-#695). An AI-extracted file is inlined as base64
    // into the Anthropic request and can't exceed 32MB regardless.
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(33 * 1024 * 1024),
    ]);
    const big = new File([pdf], "scan.pdf", { type: "application/pdf" });
    await ingestMedicalUpload(login.id, profile.id, big);

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/too large \(max 32MB\)/i);
  });

  it("accepts a >32MB HEALTH record (deterministic parse, no Anthropic cap)", async () => {
    const { login, profile } = seedActor();
    // A real 33MB FHIR bundle: over the 32MB AI cap but under the 64MB health cap
    // (MAX_HEALTH_BYTES). Health records are parsed deterministically (no API call),
    // so the AI cap must NOT apply — this upload is accepted, stored, and imported.
    // The `_pad` string keeps the JSON valid while inflating it past 32MB; the head
    // still sniffs as a FHIR Bundle.
    const pad = "X".repeat(33 * 1024 * 1024);
    const fhir = `{"resourceType":"Bundle","type":"collection","_pad":"${pad}","entry":[]}`;
    const health = new File([Buffer.from(fhir)], "export.json", {
      type: "application/fhir+json",
    });
    await ingestMedicalUpload(login.id, profile.id, health);
    // A health record over 1MB persists on a deferred tick; flush it so the parse
    // settles to a terminal status before asserting (persistHealthRecordDoc is sync).
    await new Promise((resolve) => setImmediate(resolve));

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    // Accepted, not size-rejected: an empty bundle parses cleanly to 'done'.
    expect(rows[0].status).not.toBe("failed");
    expect(rows[0].error ?? "").not.toMatch(/too large/i);
    // The original file was stored (it got past every gate into persistence).
    expect(rows[0].stored_path).toBeTruthy();
  });
});

describe("medical-pipeline: reprocess read helpers", () => {
  it("computeReprocessAllCost reports an empty cost for a profile with no documents", () => {
    const { profile } = seedActor();
    const cost = computeReprocessAllCost(profile.id);
    expect(cost.total).toBe(0);
    expect(cost.ai).toBe(0);
    expect(cost.deterministic).toBe(0);
    expect(cost.noAi).toBe(true);
  });

  it("reprocessAllForProfile is a no-op with the expected message when nothing is stored", async () => {
    const { login, profile } = seedActor();
    const res = await reprocessAllForProfile(login.id, profile.id);
    expect(res.status).toBe("done");
    expect(res.message).toBe("No uploaded documents to reprocess.");
  });
});

// #903: re-import a document from the extraction already saved on its row — the
// normalize + persist half re-run with NO model call. These run with no AI key
// configured, which is itself part of the contract: a raw re-import must not need
// one. SYNTHETIC payloads only.
describe("medical-pipeline: reprocessFromRawById (no AI call)", () => {
  const FLAT = {
    document_type: "lab report",
    document_date: "2024-03-02",
    results: [
      {
        category: "lab",
        name: "Sodium",
        canonical_name: "Sodium",
        value: "140",
        value_num: 140,
        unit: "mmol/L",
      },
      {
        category: "lab",
        name: "Potassium",
        canonical_name: "Potassium",
        value: "4.1",
        value_num: 4.1,
        unit: "mmol/L",
      },
    ],
  };

  function seedDoc(profileId: number, raw: string | null) {
    return Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (filename, stored_path, mime_type, extraction_status, raw_extraction, model, profile_id)
           VALUES ('labs.pdf', '', 'application/pdf', 'done', ?, 'some-model', ?)`
        )
        .run(raw, profileId).lastInsertRowid
    );
  }
  const recordCount = (profileId: number) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM medical_records WHERE profile_id = ?"
        )
        .get(profileId) as { c: number }
    ).c;

  it("re-imports the records from a saved flat extraction", async () => {
    const { login, profile } = seedActor();
    const id = seedDoc(profile.id, JSON.stringify(FLAT));
    expect(recordCount(profile.id)).toBe(0);

    const res = await reprocessFromRawById(login.id, profile.id, id);

    expect(res.status).toBe("done");
    expect(res.message).toMatch(/2 record\(s\)/);
    expect(recordCount(profile.id)).toBe(2);
  });

  // The motivating case (#902): the document was imported as a silent ZERO because
  // the model wrapped its payload. The saved extraction was fine all along — a raw
  // re-import recovers it without paying for a re-extraction.
  it("recovers a document whose saved extraction is wrapped in an envelope key", async () => {
    const { login, profile } = seedActor();
    const id = seedDoc(profile.id, JSON.stringify({ document_data: FLAT }));

    const res = await reprocessFromRawById(login.id, profile.id, id);

    expect(res.status).toBe("done");
    expect(recordCount(profile.id)).toBe(2);
  });

  it("preserves the ORIGINAL model attribution (a replay, not a fresh run)", async () => {
    const { login, profile } = seedActor();
    const id = seedDoc(profile.id, JSON.stringify(FLAT));
    await reprocessFromRawById(login.id, profile.id, id);
    const row = db
      .prepare("SELECT model FROM medical_documents WHERE id = ?")
      .get(id) as { model: string | null };
    expect(row.model).toBe("some-model");
  });

  it("skips a document with no saved extraction (e.g. a health record)", async () => {
    const { login, profile } = seedActor();
    const id = seedDoc(profile.id, null);
    const res = await reprocessFromRawById(login.id, profile.id, id);
    expect(res.status).toBe("skipped");
    expect(res.message).toMatch(/no saved ai extraction/i);
  });

  it("fails WITHOUT destroying existing rows when the saved extraction is unusable", async () => {
    const { login, profile } = seedActor();
    // Import once so the document owns rows...
    const id = seedDoc(profile.id, JSON.stringify(FLAT));
    await reprocessFromRawById(login.id, profile.id, id);
    expect(recordCount(profile.id)).toBe(2);

    // ...then corrupt the saved extraction and re-import: the failure must leave
    // the previously imported rows alone (never destroy data on a failure).
    db.prepare(
      "UPDATE medical_documents SET raw_extraction = ? WHERE id = ?"
    ).run("{not json", id);
    const res = await reprocessFromRawById(login.id, profile.id, id);
    expect(res.status).toBe("failed");
    expect(recordCount(profile.id)).toBe(2);
    const row = db
      .prepare("SELECT extraction_status FROM medical_documents WHERE id = ?")
      .get(id) as { extraction_status: string };
    expect(row.extraction_status).toBe("failed");
  });

  it("fails on a saved extraction whose shape is unrecognized", async () => {
    const { login, profile } = seedActor();
    const id = seedDoc(profile.id, JSON.stringify({ nothing: "useful" }));
    const res = await reprocessFromRawById(login.id, profile.id, id);
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/unrecognized shape/i);
    expect(recordCount(profile.id)).toBe(0);
  });

  // The feature REPLACES a document's records — running it twice must not
  // duplicate them. Every other test here imports from zero rows, so a regression
  // that double-inserted (2 -> 4) would otherwise sail through this whole file.
  it("is idempotent: re-importing twice replaces rather than duplicates", async () => {
    const { login, profile } = seedActor();
    const id = seedDoc(profile.id, JSON.stringify(FLAT));

    await reprocessFromRawById(login.id, profile.id, id);
    expect(recordCount(profile.id)).toBe(2);

    const again = await reprocessFromRawById(login.id, profile.id, id);
    expect(again.status).toBe("done");
    expect(recordCount(profile.id)).toBe(2);
  });

  // The headline claim of the whole feature: no model call, so no quota moves —
  // neither consumed on success nor (wrongly) refunded on failure, which would
  // inflate the user's daily allowance.
  it("consumes no AI quota on success, and refunds none on failure", async () => {
    const { login, profile } = seedActor();
    const before = getAiUsageCount(profile.id, "extraction");

    const ok = seedDoc(profile.id, JSON.stringify(FLAT));
    await reprocessFromRawById(login.id, profile.id, ok);
    expect(getAiUsageCount(profile.id, "extraction")).toBe(before);

    const bad = seedDoc(profile.id, "{not json");
    await reprocessFromRawById(login.id, profile.id, bad);
    expect(getAiUsageCount(profile.id, "extraction")).toBe(before);
  });

  // The atomic claim (#324): a document already in flight is not re-imported
  // underneath the run that owns it.
  it("skips a document that is already processing (the atomic claim)", async () => {
    const { login, profile } = seedActor();
    const id = seedDoc(profile.id, JSON.stringify(FLAT));
    db.prepare(
      "UPDATE medical_documents SET extraction_status = 'processing' WHERE id = ?"
    ).run(id);

    const res = await reprocessFromRawById(login.id, profile.id, id);

    expect(res.status).toBe("skipped");
    expect(res.message).toMatch(/already processing/i);
    expect(recordCount(profile.id)).toBe(0);
  });

  it("is profile-scoped: another profile cannot re-import this document", async () => {
    const { profile } = seedActor();
    const other = seedActor();
    const id = seedDoc(profile.id, JSON.stringify(FLAT));

    const res = await reprocessFromRawById(
      other.login.id,
      other.profile.id,
      id
    );

    expect(res.status).toBe("skipped");
    expect(res.message).toMatch(/unknown document/i);
    expect(recordCount(profile.id)).toBe(0);
    expect(recordCount(other.profile.id)).toBe(0);
  });
});
