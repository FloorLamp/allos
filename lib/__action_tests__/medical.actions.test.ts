// SERVER-ACTION TIER — medical-record write path.
//
// Covers addRecord (insert + in-transaction reconcileFlags flagging an out-of-range
// value), updateRecord, and deleteRecord. Uses Glucose, whose canonical ref_high is
// 99, so a value of 130 must derive a 'high' flag (mirrors the query smoke test).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addRecord,
  updateRecord,
  deleteRecord,
} from "@/app/(app)/medical/actions";
import { uploadMedicalDocument } from "@/app/(app)/medical/document-actions";
import {
  getMedicalRecords,
  getLatestMedicalRecordByCanonical,
} from "@/lib/queries";
import { seedActor, createProfile, actAs, fd } from "./harness";
import { MAX_AI_BYTES, MEDICAL_UPLOAD_BATCH_CAP } from "@/lib/upload-gate";

const revalidate = vi.mocked(revalidatePath);

function recordRows(profileId: number) {
  return db
    .prepare(
      "SELECT id, name, value, value_num, flag, canonical_name FROM medical_records WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as {
    id: number;
    name: string;
    value: string | null;
    value_num: number | null;
    flag: string | null;
    canonical_name: string | null;
  }[];
}

beforeEach(() => revalidate.mockClear());

describe("addRecord", () => {
  it("inserts a record and flags an out-of-range value in one transaction", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({
        date: "2026-01-15",
        category: "lab",
        name: "Glucose",
        value: "130",
        unit: "mg/dL",
        canonical_name: "Glucose",
      })
    );

    const rows = recordRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Glucose");
    // value_num derived from the numeric value → chartable.
    expect(rows[0].value_num).toBe(130);
    // reconcileFlags ran inside the write transaction: 130 > ref_high 99 → 'high'.
    expect(rows[0].flag).toBe("high");
    expect(revalidate).toHaveBeenCalledWith("/biomarkers");
  });

  it("rejects an impossible date (no row written)", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({ date: "2026-02-30", category: "lab", name: "Glucose", value: "90" })
    );
    expect(recordRows(profile.id)).toHaveLength(0);
  });

  it("rejects a blank name", async () => {
    const { profile } = seedActor();
    await addRecord(fd({ date: "2026-01-15", category: "lab", name: "  " }));
    expect(recordRows(profile.id)).toHaveLength(0);
  });

  it("validates the category server-side instead of 500-ing on the CHECK (#385)", async () => {
    const { profile } = seedActor();
    // A crafted/stale category the CHECK forbids would otherwise raise a
    // SqliteError; the action now falls back to 'lab' (as updateRecord does),
    // writing a valid row rather than throwing.
    await addRecord(
      fd({
        date: "2026-01-15",
        category: "bogus",
        name: "Glucose",
        value: "90",
      })
    );
    const rows = recordRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(
      db
        .prepare("SELECT category FROM medical_records WHERE id = ?")
        .get(rows[0].id)
    ).toEqual({ category: "lab" });
  });

  it("does not let 'prescription' be created from the Biomarkers add path (#385)", async () => {
    const { profile } = seedActor();
    // The add form only offers BIOMARKER_CATEGORIES (no 'prescription'); a crafted
    // POST is coerced to 'lab' so meds can't sneak into the biomarkers browser.
    await addRecord(
      fd({
        date: "2026-01-15",
        category: "prescription",
        name: "Atorvastatin",
        value: "10mg",
      })
    );
    const rows = recordRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(
      db
        .prepare("SELECT category FROM medical_records WHERE id = ?")
        .get(rows[0].id)
    ).toEqual({ category: "lab" });
  });
});

describe("updateRecord", () => {
  it("edits the record and re-derives its flag", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({
        date: "2026-01-15",
        category: "lab",
        name: "Glucose",
        value: "130",
        canonical_name: "Glucose",
      })
    );
    const id = recordRows(profile.id)[0].id;

    // Bring it into range → flag clears.
    await updateRecord(
      fd({
        id,
        date: "2026-01-16",
        category: "lab",
        name: "Glucose",
        value: "85",
        canonical_name: "Glucose",
      })
    );

    const row = recordRows(profile.id)[0];
    expect(row.value).toBe("85");
    expect(row.value_num).toBe(85);
    expect(row.flag).toBeNull();
    const latest = getLatestMedicalRecordByCanonical(profile.id, "glucose");
    expect(latest?.value_num).toBe(85);
  });
});

describe("deleteRecord", () => {
  it("removes the record and revalidates", async () => {
    const { profile } = seedActor();
    await addRecord(
      fd({ date: "2026-01-15", category: "lab", name: "LDL", value: "120" })
    );
    const id = recordRows(profile.id)[0].id;
    revalidate.mockClear();

    await deleteRecord(fd({ id }));

    expect(getMedicalRecords(profile.id)).toHaveLength(0);
    expect(revalidate).toHaveBeenCalledWith("/biomarkers");
  });
});

describe("manual record (no document_id) round-trips edit + delete", () => {
  it("a manually-added record edits and deletes, and both are profile-scoped", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("ManualB", login.id);

    // Add a manual record as A (the Biomarkers add slot's path — no document_id).
    actAs(login, profileA);
    await addRecord(
      fd({
        date: "2026-03-01",
        category: "lab",
        name: "LDL",
        value: "120",
        canonical_name: "LDL Cholesterol",
      })
    );
    const row = recordRows(profileA.id)[0];
    // Manual entry leaves the provenance columns NULL (it's not from a document).
    const provenance = db
      .prepare(
        "SELECT document_id, external_id FROM medical_records WHERE id = ?"
      )
      .get(row.id) as {
      document_id: number | null;
      external_id: string | null;
    };
    expect(provenance.document_id).toBeNull();
    expect(provenance.external_id).toBeNull();

    // Another profile can't edit A's row (WHERE id = ? AND profile_id = ? no-ops).
    actAs(login, profileB);
    await updateRecord(
      fd({ id: row.id, date: "2026-03-02", category: "lab", name: "HACKED" })
    );
    expect(recordRows(profileA.id)[0].name).toBe("LDL");

    // A edits its own row — the correction lands.
    actAs(login, profileA);
    await updateRecord(
      fd({
        id: row.id,
        date: "2026-03-02",
        category: "lab",
        name: "LDL",
        value: "95",
        canonical_name: "LDL Cholesterol",
      })
    );
    expect(recordRows(profileA.id)[0].value).toBe("95");

    // Another profile can't delete it either.
    actAs(login, profileB);
    await deleteRecord(fd({ id: row.id }));
    expect(recordRows(profileA.id)).toHaveLength(1);

    // A deletes its own row — gone.
    actAs(login, profileA);
    await deleteRecord(fd({ id: row.id }));
    expect(recordRows(profileA.id)).toHaveLength(0);
  });
});

describe("uploadMedicalDocument content sniffing (issue #27)", () => {
  function docRows(profileId: number) {
    return db
      .prepare(
        "SELECT filename, stored_path, mime_type, extraction_status AS status, extraction_error AS error FROM medical_documents WHERE profile_id = ? ORDER BY id"
      )
      .all(profileId) as {
      filename: string;
      stored_path: string | null;
      mime_type: string | null;
      status: string;
      error: string | null;
    }[];
  }

  function uploadForm(bytes: Buffer, name: string, type: string): FormData {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], name, { type }));
    return form;
  }

  it("rejects a file whose bytes contradict its declared type without storing it", async () => {
    const { profile } = seedActor();
    // PNG magic bytes but named/declared as a PDF → a content contradiction. The
    // action records a 'failed' row (no file on disk) instead of trusting file.type.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await uploadMedicalDocument(
      uploadForm(png, "report.pdf", "application/pdf")
    );

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    // Nothing was persisted to disk — the row carries no stored_path.
    expect(rows[0].stored_path ?? "").toBe("");
    expect(rows[0].error).toMatch(/named like a PDF/i);
    expect(rows[0].error).toMatch(/PNG image/i);
  });

  it("rejects a .png whose contents carry no image magic (mislabeled HTML)", async () => {
    const { profile } = seedActor();
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    await uploadMedicalDocument(uploadForm(html, "evil.png", "image/png"));

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].stored_path ?? "").toBe("");
    expect(rows[0].error).toMatch(/named like an image/i);
  });
});

// Multi-file upload (issue #1008). The per-file ingest engine is unchanged — this
// pins the NEW entry-point behavior: getAll("file") + the sequential loop, the ~20
// soft cap, and a mixed batch landing per-file outcomes (good files as their own
// rows, bad files as their own failed-doc rows) with no special handling.
describe("uploadMedicalDocument multi-file (issue #1008)", () => {
  function docRows(profileId: number) {
    return db
      .prepare(
        "SELECT filename, extraction_status AS status, extraction_error AS error FROM medical_documents WHERE profile_id = ? ORDER BY id"
      )
      .all(profileId) as {
      filename: string;
      status: string;
      error: string | null;
    }[];
  }

  // A tiny, UNIQUE csv per index — content-hash dedup would otherwise collapse
  // byte-identical uploads into one row, masking the per-file count under test.
  function csv(i: number): File {
    return new File(
      [
        `metric,value,unit,date\nGlucose,${90 + i},mg/dL,2026-01-0${(i % 9) + 1}\n`,
      ],
      `labs-${i}.csv`,
      { type: "text/csv" }
    );
  }

  // Every file rides under the ONE "file" key — the multi-value FormData the browser
  // multi-select / drag-drop produces.
  function batch(files: File[]): FormData {
    const form = new FormData();
    for (const f of files) form.append("file", f);
    return form;
  }

  it("ingests N files as N document rows and reports them", async () => {
    const { profile } = seedActor();
    const result = await uploadMedicalDocument(batch([csv(1), csv(2), csv(3)]));

    expect(result).toEqual({ ingested: 3, overflow: 0 });
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.filename).sort()).toEqual([
      "labs-1.csv",
      "labs-2.csv",
      "labs-3.csv",
    ]);
    // Good files were accepted (not rejected as failed-doc rows).
    expect(rows.every((r) => r.status !== "failed")).toBe(true);
  });

  it("lands per-file outcomes for a mixed batch (good + oversized + unsupported)", async () => {
    const { profile } = seedActor();
    // Oversized: a .pdf above the 32MB AI pre-buffer cap is rejected on file.size
    // BEFORE its body is buffered — insertFailedDoc, no disk write.
    const oversized = new File([new Uint8Array(MAX_AI_BYTES + 1)], "huge.pdf", {
      type: "application/pdf",
    });
    // Unsupported: neither a health record nor an AI-supported type.
    const unsupported = new File(
      [new Uint8Array([1, 2, 3, 4])],
      "malware.exe",
      {
        type: "application/x-msdownload",
      }
    );

    const result = await uploadMedicalDocument(
      batch([csv(1), oversized, csv(2), unsupported])
    );

    // All four were within the cap, so all four ran the ingest path.
    expect(result).toEqual({ ingested: 4, overflow: 0 });
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(4);

    const good = rows.filter((r) => r.filename.startsWith("labs-"));
    expect(good).toHaveLength(2);
    expect(good.every((r) => r.status !== "failed")).toBe(true);

    const big = rows.find((r) => r.filename === "huge.pdf");
    expect(big?.status).toBe("failed");
    expect(big?.error).toMatch(/too large/i);

    const bad = rows.find((r) => r.filename === "malware.exe");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toMatch(/unsupported/i);
  });

  it("enforces the ~20 soft cap: ingests 20 and reports the overflow", async () => {
    const { profile } = seedActor();
    const files = Array.from({ length: 22 }, (_, i) => csv(i + 1));
    const result = await uploadMedicalDocument(batch(files));

    expect(result).toEqual({ ingested: MEDICAL_UPLOAD_BATCH_CAP, overflow: 2 });
    // Exactly the first 20 became rows; the 2 overflow files were never ingested.
    expect(docRows(profile.id)).toHaveLength(MEDICAL_UPLOAD_BATCH_CAP);
  });

  it("is a no-op with no valid files", async () => {
    const { profile } = seedActor();
    const result = await uploadMedicalDocument(new FormData());
    expect(result).toEqual({ ingested: 0, overflow: 0 });
    expect(docRows(profile.id)).toHaveLength(0);
  });
});

describe("scoping", () => {
  it("addRecord writes only to the acting profile", async () => {
    const { login, profile: profileA } = seedActor();
    // A second profile under the same login; act as A and write.
    const profileB = createProfile("MedB", login.id);

    actAs(login, profileA);
    await addRecord(
      fd({ date: "2026-01-15", category: "lab", name: "TSH", value: "2.0" })
    );

    expect(getMedicalRecords(profileB.id)).toHaveLength(0);
    expect(getMedicalRecords(profileA.id)).toHaveLength(1);
  });
});
