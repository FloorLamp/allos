import Link from "next/link";
import {
  IconAlertTriangle,
  IconCircle,
  IconCircleCheck,
  IconLoader2,
} from "@tabler/icons-react";
import type { IntegrationId } from "@/lib/types";
import { getIntegration } from "@/lib/integrations/registry";
import { feedItemView, type FeedEntry, type FeedTone } from "@/lib/import-feed";
import { isProvenanceMismatch } from "@/lib/import-log";
import RelativeTime from "@/components/RelativeTime";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import ReprocessButton from "@/components/ReprocessButton";

// Data → Review, "Imports": the chronological feed of ONE-OFF imports into this
// profile — uploaded documents and pasted/CSV jobs — merged newest-first, where
// chronology is the point. Recurring per-provider syncs live in their own
// "Connected sources" section now (issue #208), so this feed no longer commingles
// hourly sync noise with the occasional document. Every entry renders through the
// ONE <FeedRow> below; the pure lib/import-feed shapes each into a common view, so
// only the stream-specific extras (a document's provenance flag) branch here.
// Server component — the page reads the feed via lib/queries (getImportDocumentsFeed).

function providerName(id: string): string {
  return getIntegration(id as IntegrationId)?.name ?? id;
}

function ToneIcon({ tone }: { tone: FeedTone }) {
  switch (tone) {
    case "ok":
      return (
        <IconCircleCheck
          className="h-4 w-4 shrink-0 text-emerald-500"
          stroke={1.75}
        />
      );
    case "error":
      return (
        <IconAlertTriangle
          className="h-4 w-4 shrink-0 text-rose-500"
          stroke={1.75}
        />
      );
    case "pending":
      return (
        <IconLoader2
          className="h-4 w-4 shrink-0 animate-spin text-slate-500 motion-reduce:animate-none dark:text-slate-400"
          stroke={1.75}
        />
      );
    default:
      return (
        <IconCircle
          className="h-4 w-4 shrink-0 text-slate-300 dark:text-slate-600"
          stroke={1.75}
        />
      );
  }
}

function FeedRow({
  entry,
  knownNames,
  isAdmin,
}: {
  entry: FeedEntry;
  knownNames: (string | null | undefined)[];
  isAdmin: boolean;
}) {
  const v = feedItemView(entry, providerName);
  const mismatch =
    v.patientName != null && isProvenanceMismatch(v.patientName, knownNames);
  // Admins can inspect the captured provider payload on a sync that has one (#9).
  const rawRef = entry.stream === "sync" ? entry.event.raw_ref : null;
  const rawId = entry.stream === "sync" ? entry.event.id : null;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <ToneIcon tone={v.tone} />
      {v.href ? (
        <Link
          href={v.href}
          className="font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          {v.title}
        </Link>
      ) : (
        <span className="font-medium text-slate-800 dark:text-slate-100">
          {v.title}
        </span>
      )}
      {mismatch && (
        <span
          className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
          title={`Document names “${v.patientName}”, which doesn’t match this profile.`}
        >
          <IconAlertTriangle className="h-3.5 w-3.5" />
          {v.patientName}
        </span>
      )}
      <span className="text-sm text-slate-500 dark:text-slate-400">
        <span
          className={
            v.detailMuted ? "text-slate-500 dark:text-slate-400" : undefined
          }
        >
          {v.detail}
        </span>
        {v.skipped > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            {" "}
            · {v.skipped} skipped
          </span>
        )}
      </span>
      {v.meta && (
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {v.meta}
        </span>
      )}
      <RelativeTime
        value={entry.at}
        className="ml-auto text-xs text-slate-500 dark:text-slate-400"
      />
      {isAdmin && rawRef && rawId != null && <RawPayloadViewer id={rawId} />}
    </li>
  );
}

export default function ImportFeed({
  feed,
  knownNames,
  isAdmin = false,
}: {
  feed: FeedEntry[];
  // The active profile's own name(s), for the document provenance-mismatch flag.
  knownNames: (string | null | undefined)[];
  isAdmin?: boolean;
}) {
  return (
    <div className="card">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Imports
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Documents you&apos;ve uploaded and logs you&apos;ve pasted — newest
            first. Click an item to verify what it produced.
          </p>
        </div>
        {/* "Re-extract all documents" lives in THIS header now (issue #208) so its
            scope reads unambiguously — it re-extracts every uploaded document and
            never touches the recurring syncs in "Connected sources". */}
        <ReprocessButton />
      </div>
      {feed.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          No imports yet. Upload a document, paste a log, or connect a device or
          service on the Import tab.
        </p>
      ) : (
        <ul
          className="mt-3 divide-y divide-black/5 dark:divide-white/5"
          data-testid="import-feed"
        >
          {feed.map((entry) => (
            <FeedRow
              key={feedItemView(entry, providerName).key}
              entry={entry}
              knownNames={knownNames}
              isAdmin={isAdmin}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
