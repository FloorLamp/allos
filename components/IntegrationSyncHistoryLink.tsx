import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import RelativeTime from "./RelativeTime";

// Replaces the old per-setup-page "Recent activity" table (IntegrationDebugPanel,
// retired). Sync history is rendered in exactly ONE place now — Data → Review's
// "Connected sources" (ConnectedSources), the richer latest-state + expandable-
// history card with the #674 inserted/updated/unchanged split. Rendering the same
// events twice was the #221 "one question, one computation" disease at the
// component layer (the two copies had already drifted — the debug panel still
// showed the legacy flat Recv/Wrote/Skipped triple), so the setup page keeps only
// this LINK to the single history, never a second copy (#1212). The link is a real
// destination, not a dead-end CTA (#1219).
export default function IntegrationSyncHistoryLink({
  lastSuccessAt,
  connected,
}: {
  lastSuccessAt: string | null;
  connected: boolean;
}) {
  return (
    <Link
      href="/data?section=review"
      data-testid="sync-history-link"
      className="card flex items-center justify-between gap-3 transition hover:border-brand-300 dark:hover:border-brand-800"
    >
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Sync history
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {lastSuccessAt ? (
            <>
              Last successful sync{" "}
              <RelativeTime
                value={lastSuccessAt}
                className="font-medium text-slate-600 dark:text-slate-300"
              />
              . See every sync — what it wrote, skipped, or errored — in
              Review’s Connected sources.
            </>
          ) : connected ? (
            "No successful sync yet. Track each sync — what it wrote, skipped, or errored — in Review’s Connected sources."
          ) : (
            "Not connected. Once this syncs, follow each run in Review’s Connected sources."
          )}
        </p>
      </div>
      <IconArrowRight className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
    </Link>
  );
}
