// Pure logic for the unified "all my imported data" feed (Data → Review).
//
// The Review tab folds THREE event streams into one newest-first feed: background
// integration syncs (integration_sync_events), uploaded medical documents
// (medical_documents), and pasted/CSV import jobs (import_jobs). This module owns
// the pure merge + humanizing so a single feed component can render every stream
// through one row (mirroring how lib/integrations/sync-log.ts humanizes counts).
// It stays free of any `@/lib/db` import — the profile-scoped reads live in
// lib/queries/imports.ts (getImportFeed) — so it's covered by the pure unit tier
// (lib/__tests__/import-feed.test.ts).

import {
  formatSplitLabel,
  formatWindow,
  isNoOpSyncEvent,
} from "./integrations/sync-log";
import {
  documentLogStatus,
  jobLogStatus,
  documentFormatLabel,
  jobTitle,
} from "./import-log";
import { dataSectionHref, importHref, type AppRoute } from "./hrefs";
import { reconcileProduced, feedProducedDetail } from "./produced-count";

// Structural shapes of the three source rows. Deliberately minimal (and mirrored
// from lib/types IntegrationSyncEvent / lib/queries/imports.ts) so this module
// doesn't import the DB-backed query types — the real query rows carry extra
// fields, which structural typing accepts on assignment.
export interface FeedSyncEvent {
  id: number;
  // The persisted and query models both expose the integration source id.
  source_id: string;
  at: string;
  ok: number; // 1 = success, 0 = failure
  window_start: string | null;
  window_end: string | null;
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  written: number | null;
  suppressed: number | null;
  // Edit-locked skips (#133/#659). Null on legacy rows.
  edited: number | null;
  skipped: number | null;
  error: string | null;
  raw_ref: string | null;
}

export interface FeedDocument {
  id: number;
  filename: string;
  doc_type: string | null;
  source: string | null;
  patient_name: string | null;
  extraction_status: string;
  extraction_error: string | null;
  // The row tally stamped at import time (#212).
  extracted_count: number;
  // The rows that still trace back to this document RIGHT NOW — the same footprint
  // re-counted live. Diverges from extracted_count once rows leave (delete / merge /
  // reassign), which the feed detail reconciles against the snapshot (#1339). The
  // query fills this only for DONE documents (the sole branch that shows a count);
  // it's 0 for in-flight/failed rows and never read there.
  live_count: number;
  // Extracted rows the model itself was NOT confident about (#1601) — the scrutiny
  // total off this document's stored import report. Optional: a caller/fixture that
  // predates the field, and every path with no confidence signal (deterministic
  // import, keyless extraction, pre-#1601 document), simply has none → no badge.
  confidence_scrutiny?: number;
  // The display name of the portal this document was acquired from (#1748), or null for
  // the ordinary human upload. Optional so a fixture or caller predating the column
  // simply has none — the row then says nothing about acquisition, which is correct.
  acquired_portal_name?: string | null;
  // Does this row have a file on disk? 0 for a MARKER row — the file-less 'skipped' row a
  // recognized duplicate lands (#612 bytes, #1780 records) — and 1 for a real document.
  // The SAME distinction lib/document-upload-api.ts uses to answer `duplicate` rather
  // than `stored`, read here so the feed can say which of the two a 'skipped' row is
  // instead of flattening both to one word. Optional: a fixture predating the field has
  // none, and an absent value reads as "a real document", which is the safe default.
  has_file?: number;
  uploaded_at: string;
}

export interface FeedJob {
  id: number;
  type: string;
  status: string;
  summary: string | null;
  error: string | null;
  created_at: string;
}

// The unified feed entry: a discriminated union over the three streams. Each
// carries the timestamp (`at`) and row id (`sortId`) the merge sorts on, plus the
// original row so the renderer can reach stream-specific extras (a document's
// patient-name provenance flag, a sync's admin raw payload).
// What a sync row's drill-in may promise (#1991/#1771), resolved by the caller BEFORE
// the expander renders. `count` is the number of provenance rows the drill-in will
// actually LIST — never the run's split total, which is the mismatch #1991 fixed on the
// two integration-page callers and this feed never adopted. `noun` is what those rows
// ARE: an attended portal run delivers DOCUMENTS, so its drill-in must not go looking in
// the record tables and must not say "records" while listing archives (#2999).
export interface FeedDrilldown {
  count: number;
  // Rows the run wrote that carry no openable identity, named rather than hidden.
  remainder: number;
  noun: "record" | "document";
}

export type FeedEntry =
  | {
      stream: "sync";
      at: string;
      sortId: number;
      event: FeedSyncEvent;
      // Null when this run recorded no provenance — then NO expander renders at all
      // (#1771), instead of an apologetic empty state or a count that falls to zero.
      drilldown: FeedDrilldown | null;
    }
  | { stream: "document"; at: string; sortId: number; doc: FeedDocument }
  | { stream: "job"; at: string; sortId: number; job: FeedJob };

export function syncEntry(
  event: FeedSyncEvent,
  drilldown: FeedDrilldown | null = null
): FeedEntry {
  return { stream: "sync", at: event.at, sortId: event.id, event, drilldown };
}

// A SUCCESSFUL RUN THAT WROTE NOTHING LEAVES THE FEED (#2999's owner ruling).
//
// #137 built `collapseQuietSyncs` to fold consecutive no-ops into one summary line, and
// nothing ever called it: `getImportDocumentsFeed` mapped `syncEntry` directly, so an
// all-zero portal run got a full row reading "nothing new" — a dead end sitting above
// the very archives the run fetched. The ruling replaces the collapse rather than wiring
// it up: this feed is for imports that PRODUCED something, and the full run history —
// every run, including the checks that found nothing — belongs on the Patient portals
// page, which already reads every report `listVisiblePortalRunReports` returns.
//
// A FAILURE IS NEVER DROPPED. `isNoOpSyncEvent` returns false for `!ok`, and a failure is
// the signal this feed exists to carry. A LEGACY event whose split columns are all null
// is not dropped either — it predates the accounting and is not a claim about zero.
export function dropQuietSyncs(
  eventsNewestFirst: FeedSyncEvent[]
): FeedSyncEvent[] {
  return eventsNewestFirst.filter((ev) => !isNoOpSyncEvent(ev));
}

export function documentEntry(doc: FeedDocument): FeedEntry {
  return { stream: "document", at: doc.uploaded_at, sortId: doc.id, doc };
}
export function jobEntry(job: FeedJob): FeedEntry {
  return { stream: "job", at: job.created_at, sortId: job.id, job };
}

// Merge the three streams into one newest-first feed. `at` values are the DB's
// "YYYY-MM-DD HH:MM:SS" strings, which compare lexicographically; ties break by a
// stable stream order (documents, then jobs, then syncs) and descending id, so the
// order is deterministic. Pure → unit-testable.
export function mergeFeed(entries: FeedEntry[]): FeedEntry[] {
  const streamOrder: Record<FeedEntry["stream"], number> = {
    document: 0,
    job: 1,
    sync: 2,
  };
  return [...entries].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    if (a.stream !== b.stream)
      return streamOrder[a.stream] - streamOrder[b.stream];
    return b.sortId - a.sortId;
  });
}

// ---- View model (one shape every stream renders through) ----

// The icon/emphasis a feed row carries: a completed success, a failure, an
// in-flight extraction, or a neutral terminal (skipped/duplicate/ready-to-review).
export type FeedTone = "ok" | "error" | "pending" | "neutral";

export interface FeedItemView {
  key: string;
  tone: FeedTone;
  // The row's headline — a source name, a document filename, or a job title.
  title: string;
  // Where the title links, or null for an unlinked row (integration syncs).
  href: AppRoute | null;
  // The primary count/status text and whether it renders muted (mirrors
  // formatSplitLabel so "nothing new" stays de-emphasized).
  detail: string;
  detailMuted: boolean;
  // Sync-only extra: rows the parser dropped, rendered as an amber "· N skipped"
  // segment (0 = none).
  skipped: number;
  // Document-only extra: extracted rows the model hedged on (#1601), rendered as an
  // amber "· N to check" segment pointing the reviewer at the detail page's
  // lowest-confidence-first card. 0 = no signal (or the model was sure throughout);
  // every non-document stream is 0.
  scrutiny: number;
  // Secondary meta: a sync's data window, or a document's detected format.
  meta: string | null;
  // Document-only: the stated patient name, for the provenance-mismatch flag. The
  // renderer decides whether it actually mismatches the active profile.
  patientName: string | null;
  // Document-only: the portal this document was ACQUIRED from (#1748), or null when a
  // person uploaded it. Calm and factual — it is provenance, never a warning: the whole
  // point is telling two portals' overlapping records apart, and saying nothing at all
  // for the ordinary hand-uploaded document.
  acquiredVia: string | null;
}

// Map a document's normalized log status to a feed tone.
function documentTone(status: string): FeedTone {
  switch (status) {
    case "done":
      return "ok";
    case "failed":
      return "error";
    case "processing":
      return "pending";
    default:
      return "neutral"; // skipped
  }
}

// A document's primary detail line: the produced-item count when done, else a
// short status phrase. Kept terse — the full error + breakdown live on the detail
// page the row links to.
function documentDetail(doc: FeedDocument): { detail: string; muted: boolean } {
  const status = documentLogStatus(doc.extraction_status);
  switch (status) {
    case "done":
      // "items", not "records": the tally spans every clinical kind an import
      // writes (encounters/conditions/allergies/…), not just lab records (#212).
      // The LIVE count is the truth; when rows have left the document since import,
      // the snapshot rides along as "N of M items" so the feed can't contradict the
      // detail page one click away (#1339). One pure model phrases both (#221).
      return feedProducedDetail(
        reconcileProduced(doc.extracted_count, doc.live_count)
      );
    case "processing":
      return { detail: "extracting…", muted: true };
    case "failed":
      return { detail: "import failed", muted: false };
    default:
      // 'skipped' covers two very different things, and the feed used to say the same
      // bare word for both. A row with NO file is a duplicate MARKER — the engine
      // recognized the upload and stored nothing — whereas a 'skipped' row that DOES have
      // a file is a real document whose extraction declined or was shed by the AI queue,
      // and is reprocessable. Saying "duplicate" for the first is the honest reading
      // (#1780): a person scanning Review after a second portal collection should see
      // that nothing was lost, not a word that looks like a failure. Muted either way —
      // neither is an error, and neither needs action.
      return doc.has_file === 0
        ? { detail: "duplicate — nothing imported", muted: true }
        : { detail: "skipped", muted: true };
  }
}

// Map a job's normalized log status to a feed tone. A 'ready' (partial) job is
// awaiting review, so it reads neutral rather than a completed success.
function jobTone(status: string): FeedTone {
  switch (status) {
    case "failed":
      return "error";
    case "processing":
      return "pending";
    default:
      return "neutral"; // partial (ready) / skipped
  }
}

function jobDetail(job: FeedJob): { detail: string; muted: boolean } {
  const status = jobLogStatus(job.status);
  switch (status) {
    case "partial":
      return {
        detail: job.summary
          ? `${job.summary} · review to save`
          : "ready to review",
        muted: false,
      };
    case "processing":
      return { detail: "extracting…", muted: true };
    case "failed":
      return { detail: "extraction failed", muted: false };
    default:
      return { detail: "skipped", muted: true };
  }
}

// Reduce one feed entry to the display-ready shape the row component renders.
// `sourceName` resolves an integration id to its display label (passed in so
// this module doesn't reach into the registry / DB). Pure → unit-testable.
export function feedItemView(
  entry: FeedEntry,
  sourceName: (id: string) => string
): FeedItemView {
  if (entry.stream === "sync") {
    const ev = entry.event;
    const { primary, muted } = formatSplitLabel(ev);
    const hasPartialSplit =
      ev.inserted !== null || ev.updated !== null || ev.unchanged !== null;
    return {
      key: `sync:${ev.id}`,
      tone: ev.ok ? "ok" : "error",
      title: sourceName(ev.source_id),
      href: null,
      // An archive write can fail after earlier chunks committed. Keep "failed" as
      // the headline while retaining the completed split so Review tells the truth
      // about what landed before the retry-safe stop.
      detail: ev.ok
        ? primary
        : hasPartialSplit
          ? `import failed · ${primary}`
          : "import failed",
      detailMuted: ev.ok ? muted : false,
      skipped: ev.skipped ?? 0,
      scrutiny: 0,
      // A STRUCTURALLY-EMPTY WINDOW RENDERS NOTHING (#1991 defect 5, #2999). An
      // attended portal run has no data window on ANY run — the concept does not apply
      // to a delivered archive — so `formatWindow`'s "—" was a column of em-dashes
      // pretending to be information. The window still renders wherever a source
      // actually reports one.
      meta:
        ev.window_start || ev.window_end
          ? formatWindow(ev.window_start, ev.window_end)
          : null,
      patientName: null,
      acquiredVia: null,
    };
  }
  if (entry.stream === "document") {
    const doc = entry.doc;
    const { detail, muted } = documentDetail(doc);
    return {
      key: `doc:${doc.id}`,
      tone: documentTone(documentLogStatus(doc.extraction_status)),
      title: doc.filename,
      href: importHref(doc.id),
      detail,
      detailMuted: muted,
      skipped: 0,
      // Only a DONE document can have produced rows to scrutinize; an in-flight or
      // failed row's stale report must not badge a count next to "import failed".
      scrutiny:
        documentLogStatus(doc.extraction_status) === "done"
          ? (doc.confidence_scrutiny ?? 0)
          : 0,
      meta: documentFormatLabel(doc),
      patientName: doc.patient_name,
      acquiredVia: doc.acquired_portal_name ?? null,
    };
  }
  const job = entry.job;
  const { detail, muted } = jobDetail(job);
  return {
    key: `job:${job.id}`,
    tone: jobTone(jobLogStatus(job.status)),
    title: jobTitle(job.type),
    href: dataSectionHref("import", "paste-import"),
    detail,
    detailMuted: muted,
    skipped: 0,
    scrutiny: 0,
    meta: null,
    patientName: null,
    acquiredVia: null,
  };
}
