import { describe, it, expect } from "vitest";
import {
  mergeFeed,
  syncEntry,
  documentEntry,
  jobEntry,
  feedItemView,
  type FeedSyncEvent,
  type FeedDocument,
  type FeedJob,
} from "@/lib/import-feed";

// ---- test factories ----

function sync(over: Partial<FeedSyncEvent> = {}): FeedSyncEvent {
  return {
    id: 1,
    provider: "health-connect",
    at: "2026-07-08 07:00:00",
    ok: 1,
    window_start: "2026-07-06",
    window_end: "2026-07-08",
    inserted: 30,
    updated: 10,
    unchanged: 0,
    written: 40,
    skipped: 2,
    error: null,
    raw_ref: null,
    ...over,
  };
}

function doc(over: Partial<FeedDocument> = {}): FeedDocument {
  return {
    id: 5,
    filename: "labs.pdf",
    doc_type: "Lab report",
    source: null,
    patient_name: null,
    extraction_status: "done",
    extraction_error: null,
    extracted_count: 12,
    uploaded_at: "2026-07-08 09:00:00",
    ...over,
  };
}

function job(over: Partial<FeedJob> = {}): FeedJob {
  return {
    id: 3,
    type: "biomarkers",
    status: "ready",
    summary: "5 readings",
    error: null,
    created_at: "2026-07-08 08:00:00",
    ...over,
  };
}

const providerName = (id: string) =>
  id === "health-connect" ? "Google Health Connect" : id;

describe("mergeFeed", () => {
  it("orders newest-first across all three streams by `at`", () => {
    const merged = mergeFeed([
      syncEntry(sync({ id: 1, at: "2026-07-08 07:00:00" })),
      documentEntry(doc({ id: 5, uploaded_at: "2026-07-08 09:00:00" })),
      jobEntry(job({ id: 3, created_at: "2026-07-08 08:00:00" })),
    ]);
    expect(merged.map((e) => e.stream)).toEqual(["document", "job", "sync"]);
  });

  it("breaks ties by stream order (document, job, sync) then descending id", () => {
    const at = "2026-07-08 10:00:00";
    const merged = mergeFeed([
      syncEntry(sync({ id: 100, at })),
      jobEntry(job({ id: 3, created_at: at })),
      documentEntry(doc({ id: 5, uploaded_at: at })),
      documentEntry(doc({ id: 9, uploaded_at: at })),
    ]);
    // Two same-time documents come first (id desc: 9 then 5), then the job, then
    // the sync.
    expect(merged.map((e) => `${e.stream}:${e.sortId}`)).toEqual([
      "document:9",
      "document:5",
      "job:3",
      "sync:100",
    ]);
  });

  it("does not mutate its input", () => {
    const entries = [
      syncEntry(sync({ at: "2026-07-01 00:00:00" })),
      documentEntry(doc({ uploaded_at: "2026-07-09 00:00:00" })),
    ];
    const before = entries.map((e) => e.stream);
    mergeFeed(entries);
    expect(entries.map((e) => e.stream)).toEqual(before);
  });
});

describe("feedItemView — sync", () => {
  it("humanizes the #273 split and carries the data window + skipped", () => {
    const v = feedItemView(syncEntry(sync()), providerName);
    expect(v.tone).toBe("ok");
    expect(v.title).toBe("Google Health Connect");
    expect(v.href).toBeNull();
    expect(v.detail).toBe("30 new · 10 changed");
    expect(v.detailMuted).toBe(false);
    expect(v.skipped).toBe(2);
    expect(v.meta).toBe("2026-07-06 → 2026-07-08");
  });

  it("collapses an all-unchanged re-scan to a muted 'nothing new'", () => {
    const v = feedItemView(
      syncEntry(sync({ inserted: 0, updated: 0, unchanged: 6, skipped: 0 })),
      providerName
    );
    expect(v.detail).toBe("nothing new");
    expect(v.detailMuted).toBe(true);
    expect(v.skipped).toBe(0);
  });

  it("marks a failed sync with the error tone", () => {
    const v = feedItemView(
      syncEntry(sync({ ok: 0, error: "token refresh failed" })),
      providerName
    );
    expect(v.tone).toBe("error");
  });
});

describe("feedItemView — document", () => {
  it("links to the detail page and shows the produced count when done", () => {
    const v = feedItemView(
      documentEntry(doc({ extracted_count: 12 })),
      providerName
    );
    expect(v.tone).toBe("ok");
    expect(v.title).toBe("labs.pdf");
    expect(v.href).toBe("/import/5");
    expect(v.detail).toBe("12 records");
    expect(v.meta).toBe("Lab report");
    expect(v.patientName).toBeNull();
  });

  it("reads a done-but-empty extraction as a muted 'no records'", () => {
    const v = feedItemView(
      documentEntry(doc({ extracted_count: 0 })),
      providerName
    );
    expect(v.detail).toBe("no records");
    expect(v.detailMuted).toBe(true);
  });

  it("marks a failed upload with the error tone (issue #58 rejections)", () => {
    const v = feedItemView(
      documentEntry(
        doc({
          extraction_status: "failed",
          extraction_error: "Unsupported file type.",
        })
      ),
      providerName
    );
    expect(v.tone).toBe("error");
    expect(v.detail).toBe("import failed");
  });

  it("shows an in-flight extraction as pending", () => {
    const v = feedItemView(
      documentEntry(doc({ extraction_status: "processing" })),
      providerName
    );
    expect(v.tone).toBe("pending");
    expect(v.detail).toBe("extracting…");
  });

  it("carries the stated patient name for the provenance flag", () => {
    const v = feedItemView(
      documentEntry(doc({ patient_name: "Test Patient" })),
      providerName
    );
    expect(v.patientName).toBe("Test Patient");
  });
});

describe("feedItemView — job", () => {
  it("prompts review on a ready paste job and links back to the importer", () => {
    const v = feedItemView(
      jobEntry(job({ status: "ready", type: "biomarkers" })),
      providerName
    );
    expect(v.tone).toBe("neutral");
    expect(v.title).toBe("Pasted labs");
    expect(v.href).toBe("/data?section=import#paste-import");
    expect(v.detail).toBe("5 readings · review to save");
  });

  it("marks a failed job with the error tone", () => {
    const v = feedItemView(
      jobEntry(job({ status: "failed", summary: null })),
      providerName
    );
    expect(v.tone).toBe("error");
    expect(v.detail).toBe("extraction failed");
  });

  it("shows a processing job as pending", () => {
    const v = feedItemView(
      jobEntry(job({ status: "processing", summary: null })),
      providerName
    );
    expect(v.tone).toBe("pending");
    expect(v.detail).toBe("extracting…");
  });
});
