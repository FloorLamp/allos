import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import SyncTimestamp from "./integrations/SyncTimestamp";

// The link from a ONE-OFF archive importer's page (Fitbit Takeout) to its entries in
// Data → Review's chronological Imports feed.
//
// It used to serve the recurring sources too, pointing at Review's Connected
// sources — because #1212 had made Review the single home of sync history and the
// setup pages kept only a link to it. #1772 inverted that: a recurring source's page
// IS its home, so it renders the real history table (SyncHistoryTable) and Review
// became an inbox that links back here. History still lives in exactly one place per
// stream; it moved.
//
// An archive import is different in kind — a one-off event in a chronological feed,
// not a recurring stream with a per-source history — so its page still links out to
// where that feed lives.
export default function IntegrationSyncHistoryLink({
  lastSuccessAt,
}: {
  lastSuccessAt: string | null;
}) {
  return (
    <Link
      href="/data?section=review"
      data-testid="sync-history-link"
      className="card flex items-center justify-between gap-3 transition hover:border-brand-300 dark:hover:border-brand-800"
    >
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Import history
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {lastSuccessAt ? (
            <>
              Last successful import{" "}
              <SyncTimestamp
                value={lastSuccessAt}
                className="font-medium text-slate-600 dark:text-slate-300"
                relativeOnly
              />
              . See every attempt — what it wrote, skipped, or errored — in
              Review’s Imports.
            </>
          ) : (
            "No successful import yet. Track each attempt — what it wrote, skipped, or errored — in Review’s Imports."
          )}
        </p>
      </div>
      <IconArrowRight className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
    </Link>
  );
}
