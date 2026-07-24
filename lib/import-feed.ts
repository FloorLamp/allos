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
  provider: string;
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
export type FeedEntry =
  | { stream: "sync"; at: string; sortId: number; event: FeedSyncEvent }
  // A collapsed run of consecutive no-op syncs for ONE provider (issue #137):
  // `count` such syncs found nothing new, the newest at `latest` (which is also the
  // entry's sort time) and the oldest at `oldest`.
  | {
      stream: "sync-quiet";
      at: string;
      sortId: number;
      provider: string;
      count: number;
      oldest: string;
      latest: string;
    }
  | { stream: "document"; at: string; sortId: number; doc: FeedDocument }
  | { stream: "job"; at: string; sortId: number; job: FeedJob };

export function syncEntry(event: FeedSyncEvent): FeedEntry {
  return { stream: "sync", at: event.at, sortId: event.id, event };
}

// Collapse a run of consecutive no-op syncs (newest-first, non-empty, all the same
// provider) into one summary entry pinned at the newest event's time/id. Pure.
export function syncQuietEntry(runNewestFirst: FeedSyncEvent[]): FeedEntry {
  const latest = runNewestFirst[0];
  const oldest = runNewestFirst[runNewestFirst.length - 1];
  return {
    stream: "sync-quiet",
    at: latest.at,
    sortId: latest.id,
    provider: latest.provider,
    count: runNewestFirst.length,
    oldest: oldest.at,
    latest: latest.at,
  };
}

// Fold a profile's raw sync events (newest-first, providers interleaved) into feed
// entries, collapsing each maximal run of CONSECUTIVE no-op syncs PER PROVIDER into
// a single "no new data" summary. A meaningful sync (something inserted/updated) or
// a failure renders as its own entry, so a currently-broken integration and its
// recovery history stay fully visible; only the hourly "nothing new" noise (#137) is
// summarized. Grouping is per-provider so two devices both checking in hourly each
// collapse their own run instead of breaking each other's. Pure → unit-testable.
export function collapseQuietSyncs(
  eventsNewestFirst: FeedSyncEvent[]
): FeedEntry[] {
  const byProvider = new Map<string, FeedSyncEvent[]>();
  for (const ev of eventsNewestFirst) {
    const list = byProvider.get(ev.provider);
    if (list) list.push(ev);
    else byProvider.set(ev.provider, [ev]);
  }
  const out: FeedEntry[] = [];
  for (const evs of byProvider.values()) {
    let i = 0;
    while (i < evs.length) {
      if (!isNoOpSyncEvent(evs[i])) {
        out.push(syncEntry(evs[i]));
        i++;
        continue;
      }
      let j = i;
      while (j < evs.length && isNoOpSyncEvent(evs[j])) j++;
      out.push(syncQuietEntry(evs.slice(i, j)));
      i = j;
    }
  }
  return out;
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
    "sync-quiet": 3,
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
  // The row's headline — a provider name, a document filename, or a job title.
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
  // Secondary meta: a sync's data window, or a document's detected format.
  meta: string | null;
  // Document-only: the stated patient name, for the provenance-mismatch flag. The
  // renderer decides whether it actually mismatches the active profile.
  patientName: string | null;
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
      return { detail: "skipped", muted: true };
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
// `providerName` resolves an integration id to its display label (passed in so
// this module doesn't reach into the registry / DB). Pure → unit-testable.
export function feedItemView(
  entry: FeedEntry,
  providerName: (id: string) => string
): FeedItemView {
  if (entry.stream === "sync") {
    const ev = entry.event;
    const { primary, muted } = formatSplitLabel(ev);
    return {
      key: `sync:${ev.id}`,
      tone: ev.ok ? "ok" : "error",
      title: providerName(ev.provider),
      href: null,
      detail: primary,
      detailMuted: muted,
      skipped: ev.skipped ?? 0,
      meta: formatWindow(ev.window_start, ev.window_end),
      patientName: null,
    };
  }
  if (entry.stream === "sync-quiet") {
    return {
      key: `sync-quiet:${entry.provider}:${entry.sortId}`,
      tone: "neutral",
      title: providerName(entry.provider),
      href: null,
      detail:
        entry.count === 1
          ? "No new data"
          : `No new data · ${entry.count} checks`,
      detailMuted: true,
      skipped: 0,
      meta: null,
      patientName: null,
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
      meta: documentFormatLabel(doc),
      patientName: doc.patient_name,
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
    meta: null,
    patientName: null,
  };
}
