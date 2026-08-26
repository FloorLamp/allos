import { describe, it, expect } from "vitest";
import {
  mergeFeed,
  syncEntry,
  documentEntry,
  jobEntry,
  feedItemView,
  dropQuietSyncs,
  type FeedSyncEvent,
  type FeedDocument,
  type FeedJob,
} from "@/lib/import-feed";

// ---- test factories ----

function sync(over: Partial<FeedSyncEvent> = {}): FeedSyncEvent {
  return {
    id: 1,
    source_id: "health-connect",
    at: "2026-07-08 07:00:00",
    ok: 1,
    window_start: "2026-07-06",
    window_end: "2026-07-08",
    superseded: 0,
    inserted: 30,
    updated: 10,
    unchanged: 0,
    written: 40,
    suppressed: 0,
    edited: 0,
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
    // Default: no drift (live matches the snapshot) so existing cases keep asserting
    // the plain "N items" phrasing. Drift cases override live_count (#1339).
    live_count: 12,
    uploaded_at: "2026-07-08 09:00:00",
    ...over,
  };
}

function job(over: Partial<FeedJob> = {}): FeedJob {
  return {
    id: 3,
    type: "clinical-results",
    status: "ready",
    summary: "5 readings",
    error: null,
    created_at: "2026-07-08 08:00:00",
    ...over,
  };
}

const sourceName = (id: string) =>
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
  it("humanizes the split and carries the data window + skipped", () => {
    const v = feedItemView(syncEntry(sync()), sourceName);
    expect(v.tone).toBe("ok");
    expect(v.title).toBe("Google Health Connect");
    expect(v.href).toBeNull();
    expect(v.detail).toBe("30 new · 10 changed");
    expect(v.detailMuted).toBe(false);
    expect(v.skipped).toBe(2);
    expect(v.meta).toBe("2026-07-06 → 2026-07-08");
  });

  it("renders NO window when the run has none, instead of an em-dash (#2999)", () => {
    // An attended portal run has no data window on ANY run — the concept does not
    // apply to a delivered archive — so formatWindow's "—" was a structurally constant
    // column pretending to be information (#1991 defect 5).
    const v = feedItemView(
      syncEntry(sync({ window_start: null, window_end: null })),
      sourceName
    );
    expect(v.meta).toBeNull();
  });

  it("still renders a one-sided window, which IS information", () => {
    const v = feedItemView(
      syncEntry(sync({ window_start: "2026-07-06", window_end: null })),
      sourceName
    );
    expect(v.meta).toBe("2026-07-06");
  });

  it("carries the caller-resolved drill-in promise, or none at all (#1991/#1771)", () => {
    // The entry, not the row component, decides: no provenance → no expander, and the
    // promised count is what the fetch will list rather than the run's split total.
    expect(syncEntry(sync())).toMatchObject({ drilldown: null });
    expect(
      syncEntry(sync(), { count: 2, remainder: 0, noun: "document" })
    ).toMatchObject({
      drilldown: { count: 2, remainder: 0, noun: "document" },
    });
  });

  it("collapses an all-unchanged re-scan to a muted 'nothing new'", () => {
    const v = feedItemView(
      syncEntry(sync({ inserted: 0, updated: 0, unchanged: 6, skipped: 0 })),
      sourceName
    );
    expect(v.detail).toBe("nothing new");
    expect(v.detailMuted).toBe(true);
    expect(v.skipped).toBe(0);
  });

  it("marks a failed sync with the error tone", () => {
    const v = feedItemView(
      syncEntry(
        sync({
          ok: 0,
          inserted: null,
          updated: null,
          unchanged: null,
          written: null,
          error: "Your Strava connection expired. Reconnect to resume syncing.",
        })
      ),
      sourceName
    );
    expect(v.tone).toBe("error");
    expect(v.detail).toBe("import failed");
  });

  it("retains the committed split on a failed chunked archive import", () => {
    const v = feedItemView(
      syncEntry(
        sync({
          ok: 0,
          source_id: "fitbit-takeout",
          inserted: 3,
          updated: 1,
          unchanged: 0,
          written: 4,
          error: "Takeout import stopped after writing 4 records.",
        })
      ),
      sourceName
    );
    expect(v.tone).toBe("error");
    expect(v.detail).toBe("import failed · 3 new · 1 changed");
  });
});

describe("feedItemView — document", () => {
  it("links to the detail page and shows the produced count when done", () => {
    const v = feedItemView(
      documentEntry(doc({ extracted_count: 12, live_count: 12 })),
      sourceName
    );
    expect(v.tone).toBe("ok");
    expect(v.title).toBe("labs.pdf");
    expect(v.href).toBe("/import/5");
    // "items", not "records" — the count spans every clinical kind (#212).
    expect(v.detail).toBe("12 items");
    expect(v.meta).toBe("Lab report");
    expect(v.patientName).toBeNull();
  });

  it("renders a single produced item as '1 item' (not '1 items')", () => {
    const v = feedItemView(
      documentEntry(doc({ extracted_count: 1, live_count: 1 })),
      sourceName
    );
    expect(v.detail).toBe("1 item");
    expect(v.detailMuted).toBe(false);
  });

  it("reads a done-but-empty extraction as a muted 'no items'", () => {
    const v = feedItemView(
      documentEntry(doc({ extracted_count: 0, live_count: 0 })),
      sourceName
    );
    expect(v.detail).toBe("no items");
    expect(v.detailMuted).toBe(true);
  });

  // #1339: rows leave a document (delete / merge / reassign) but the extracted_count
  // snapshot doesn't follow — so the feed shows the LIVE count with the snapshot as
  // context ("N of M items") instead of a bare, now-wrong "M items".
  it("reconciles a fully-drained document as a muted 'M of N' (not the snapshot)", () => {
    const v = feedItemView(
      documentEntry(doc({ extracted_count: 7, live_count: 0 })),
      sourceName
    );
    expect(v.detail).toBe("0 of 7 items");
    expect(v.detailMuted).toBe(true);
  });

  it("reconciles a partially-drifted document as 'live of extracted'", () => {
    const v = feedItemView(
      documentEntry(doc({ extracted_count: 33, live_count: 32 })),
      sourceName
    );
    expect(v.detail).toBe("32 of 33 items");
    expect(v.detailMuted).toBe(false);
  });

  it("marks a failed upload with the error tone (issue #58 rejections)", () => {
    const v = feedItemView(
      documentEntry(
        doc({
          extraction_status: "failed",
          extraction_error: "Unsupported file type.",
        })
      ),
      sourceName
    );
    expect(v.tone).toBe("error");
    expect(v.detail).toBe("import failed");
  });

  it("shows an in-flight extraction as pending", () => {
    const v = feedItemView(
      documentEntry(doc({ extraction_status: "processing" })),
      sourceName
    );
    expect(v.tone).toBe("pending");
    expect(v.detail).toBe("extracting…");
  });

  it("carries the stated patient name for the provenance flag", () => {
    const v = feedItemView(
      documentEntry(doc({ patient_name: "Test Patient" })),
      sourceName
    );
    expect(v.patientName).toBe("Test Patient");
  });

  // #1780: 'skipped' covered two unrelated things and the feed said the same bare word
  // for both. A FILE-LESS 'skipped' row is a recognized duplicate — the engine stored
  // nothing on purpose — and a person scanning Review after a second portal collection
  // must be able to tell that from an extraction that declined.
  it("reads a file-less skipped marker as a duplicate, not a bare skip", () => {
    const v = feedItemView(
      documentEntry(
        doc({
          extraction_status: "skipped",
          has_file: 0,
          extracted_count: 0,
          live_count: 0,
          extraction_error:
            'Duplicate records — … already imported from "first.xml".',
        })
      ),
      sourceName
    );
    expect(v.detail).toBe("duplicate — nothing imported");
    // Neither kind is an error: both stay muted and neutral.
    expect(v.tone).toBe("neutral");
  });

  it("still reads a skipped row that HAS a file as a plain skip (reprocessable)", () => {
    const v = feedItemView(
      documentEntry(doc({ extraction_status: "skipped", has_file: 1 })),
      sourceName
    );
    expect(v.detail).toBe("skipped");
  });
});

describe("feedItemView — job", () => {
  it("prompts review on a ready paste job and links back to the importer", () => {
    const v = feedItemView(
      jobEntry(job({ status: "ready", type: "clinical-results" })),
      sourceName
    );
    expect(v.tone).toBe("neutral");
    expect(v.title).toBe("Pasted clinical results");
    expect(v.href).toBe("/data?section=import#paste-import");
    expect(v.detail).toBe("5 readings · review to save");
  });

  it("marks a failed job with the error tone", () => {
    const v = feedItemView(
      jobEntry(job({ status: "failed", summary: null })),
      sourceName
    );
    expect(v.tone).toBe("error");
    expect(v.detail).toBe("extraction failed");
  });

  it("shows a processing job as pending", () => {
    const v = feedItemView(
      jobEntry(job({ status: "processing", summary: null })),
      sourceName
    );
    expect(v.tone).toBe("pending");
    expect(v.detail).toBe("extracting…");
  });
});

// A no-op (all-unchanged) PORTAL run — the only shape the drop rule reaches (#137's
// question, #2999's answer).
function quiet(over: Partial<FeedSyncEvent> = {}): FeedSyncEvent {
  return sync({
    source_id: "patient-portals",
    inserted: 0,
    updated: 0,
    unchanged: 6,
    written: 6,
    skipped: 0,
    ...over,
  });
}

// Nothing this feed shows delivered documents unless a test says so.
const deliveredNothing = () => false;

// #137 built `collapseQuietSyncs` to fold consecutive no-ops into one summary line, and
// nothing ever called it — `getImportDocumentsFeed` mapped `syncEntry` directly, so an
// all-zero run got a full row reading "nothing new". #2999's owner ruling replaces the
// collapse rather than wiring it up: this feed is for imports that PRODUCED something,
// and the latest portal run of each kind is stated on the Patient portals page.
describe("dropQuietSyncs (#2999)", () => {
  it("drops a successful PORTAL run that wrote nothing", () => {
    expect(dropQuietSyncs([quiet({ id: 1 })], deliveredNothing)).toEqual([]);
  });

  it("keeps a FAILURE, which is the signal the feed exists to carry", () => {
    const failed = quiet({
      id: 5,
      ok: 0,
      error: "boom",
      unchanged: 0,
    });
    expect(dropQuietSyncs([failed], deliveredNothing)).toEqual([failed]);
  });

  it("keeps a run that actually wrote something", () => {
    const real = quiet({ id: 2, inserted: 5, unchanged: 0 });
    expect(
      dropQuietSyncs(
        [quiet({ id: 3 }), real, quiet({ id: 1 })],
        deliveredNothing
      )
    ).toEqual([real]);
  });

  it("keeps a LEGACY event whose split predates the accounting", () => {
    const legacy = quiet({
      id: 7,
      inserted: null,
      updated: null,
      unchanged: null,
      written: 4,
    });
    expect(dropQuietSyncs([legacy], deliveredNothing)).toEqual([legacy]);
  });

  it("keeps a run that only suppressed or held back rows — it did something", () => {
    const suppressed = quiet({ id: 8, unchanged: 0, suppressed: 2 });
    const edited = quiet({ id: 9, unchanged: 0, edited: 1 });
    expect(dropQuietSyncs([suppressed, edited], deliveredNothing)).toEqual([
      suppressed,
      edited,
    ]);
  });

  // THREE EDGES THE RULE MUST NOT REACH. Each of these was dropped by the first cut, and
  // each drop cost a real import its only trace in the app.

  it("keeps a zero-write run from ANOTHER SOURCE — the ruling was about portal runs", () => {
    // A re-handed Fitbit Takeout archive: `inserted 0 / unchanged 900`, deliberate and
    // user-initiated, and with no portals page to fall back on.
    const takeout = quiet({
      id: 11,
      source_id: "fitbit-takeout",
      unchanged: 900,
      written: 900,
    });
    expect(dropQuietSyncs([takeout], deliveredNothing)).toEqual([takeout]);
  });

  it("keeps a portal run whose only content is documents it could not push", () => {
    const skipped = quiet({ id: 12, unchanged: 0, skipped: 3 });
    expect(dropQuietSyncs([skipped], deliveredNothing)).toEqual([skipped]);
  });

  it("keeps a zero-split portal run that DELIVERED documents", () => {
    // The observed case: a push whose report said `nothing-new` while two archives
    // landed. Dropping this row strands the documents it claimed — no later run can
    // re-claim them, and the event that owns them never renders.
    const delivery = quiet({ id: 13 });
    expect(dropQuietSyncs([delivery], (ev) => ev.id === 13)).toEqual([
      delivery,
    ]);
  });

  it("returns an empty list for no events", () => {
    expect(dropQuietSyncs([], deliveredNothing)).toEqual([]);
  });
});

describe("feedItemView — extraction-confidence badge (#1601)", () => {
  it("carries the scrutiny count for a done document", () => {
    const v = feedItemView(
      documentEntry(doc({ confidence_scrutiny: 3 })),
      sourceName
    );
    expect(v.scrutiny).toBe(3);
    // The badge is additive — the produced-count detail is untouched.
    expect(v.detail).toBe("12 items");
  });

  it("is 0 when the document carries no confidence signal", () => {
    // A deterministic import, a keyless extraction, and any pre-#1601 document all
    // land here: no badge, and never a fabricated 0-vs-unknown distinction on screen.
    expect(feedItemView(documentEntry(doc()), sourceName).scrutiny).toBe(0);
    expect(
      feedItemView(documentEntry(doc({ confidence_scrutiny: 0 })), sourceName)
        .scrutiny
    ).toBe(0);
  });

  it("never badges an in-flight or failed document", () => {
    // A stale report from a previous attempt must not put "N to check" next to
    // "import failed" / "extracting…" — there is nothing reviewable yet.
    for (const status of ["processing", "pending", "failed", "skipped"]) {
      const v = feedItemView(
        documentEntry(
          doc({ extraction_status: status, confidence_scrutiny: 4 })
        ),
        sourceName
      );
      expect(v.scrutiny, status).toBe(0);
    }
  });

  it("is 0 for every non-document stream", () => {
    expect(feedItemView(syncEntry(sync()), sourceName).scrutiny).toBe(0);
    expect(feedItemView(jobEntry(job()), sourceName).scrutiny).toBe(0);
  });
});
