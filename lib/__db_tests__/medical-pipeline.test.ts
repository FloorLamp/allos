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
    // A File larger than the 32MB cap, reported via file.size — the pre-buffer
    // gate must reject it without reading the body.
    const big = new File([Buffer.from("x")], "huge.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(big, "size", { value: 40 * 1024 * 1024 });
    await ingestMedicalUpload(login.id, profile.id, big);

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/too large/i);
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
