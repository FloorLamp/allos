import DestinationIndicator from "@/components/DestinationIndicator";
import OverlayDestination from "@/components/OverlayDestination";
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
    <OverlayDestination
      href="/data?section=review"
      label="Open import history"
      data-testid="sync-history-link"
    >
      <div
        // NOT A `.card` (#3466 class B). Its only host — the Fitbit Takeout page's
        // Status card — mounts it INSIDE a `.card`, so the card chrome drew a second
        // border and spent a second gutter within the first. It is a SUB-PANEL of its
        // host: same border language, same hover affordance, the class A inset.
        className="subpanel-inset flex items-center justify-between gap-3 rounded-lg border border-black/10 p-4 transition group-hover:border-brand-300 dark:border-white/10 dark:group-hover:border-brand-800"
        data-testid="sync-history-surface"
      >
        <div>
          <h2 className="inline-flex items-center gap-1 font-semibold text-link">
            Import history
            <DestinationIndicator />
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
      </div>
    </OverlayDestination>
  );
}
