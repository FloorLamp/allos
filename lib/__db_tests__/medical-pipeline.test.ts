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
} from "@/lib/medical-pipeline";
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
