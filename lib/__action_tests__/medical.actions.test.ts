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
