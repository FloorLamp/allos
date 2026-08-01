import { IconCheck, IconCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { IntegrationState } from "@/lib/queries/integrations";
import {
  formatCoverage,
  standingBadge,
} from "@/lib/integrations/provider-state";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import SyncRowsDrilldown from "@/components/SyncRowsDrilldown";
import StatusBadge from "./StatusBadge";
import SyncTimestamp from "./SyncTimestamp";
import { SyncDetailsNotes, SyncOutcomeLine } from "./SyncOutcome";

// Records a sync actually wrote (inserted + updated) — the count the provenance
// drill-in (#1333) can resolve to deep links. It is the SUMMARY count, shown either
// way; whether the DRILL-IN is offered is a separate question answered by recorded
// provenance (#1771), not by this number.
function writtenCount(ev: {
  ok: number;
  inserted: number | null;
  updated: number | null;
}): number {
  if (!ev.ok) return 0;
  return (ev.inserted ?? 0) + (ev.updated ?? 0);
}

// THE status header for one integration (#1772) — the answer to "what's the state of
// this integration", rendered identically wherever it is asked. The provider's setup
// page (its home) puts it at the top of the page with the connect/disconnect/sync
// controls; Review's inbox renders the same component for a provider that needs
// attention. They used to be two hand-mirrored cards with different badges, different
// timestamp formats, and different accountings.
//
// `controls` is the per-surface slot (the responsive/shared-content rule): the shape
// is shared, the buttons belong to whoever is rendering.
export default function IntegrationStatusHeader({
  state,
  showName = false,
  controls,
  isAdmin = false,
  testid,
}: {
  state: IntegrationState;
  // Review lists several providers, so it names each; the setup page's PageHeader
  // already carries the name.
  showName?: boolean;
  controls?: ReactNode;
  isAdmin?: boolean;
  testid?: string;
}) {
  const { latest, standing, vocabulary } = state;
  const badge = standingBadge(standing);
  const coverage = latest ? formatCoverage(latest, vocabulary) : null;
  const provenance = new Set(state.provenanceEventIds);
  const written = latest ? writtenCount(latest) : 0;

  return (
    <div data-testid={testid}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {showName && (
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {state.name}
            </span>
          )}
          <StatusBadge
            label={badge.label}
            tone={badge.tone}
            icon={
              badge.tone === "good" ? (
                <IconCheck className="h-3.5 w-3.5" />
              ) : undefined
            }
            testid={`sync-status-${state.id}`}
          />
        </div>
        {latest && (
          <SyncTimestamp
            value={latest.at}
            className="text-xs text-slate-500 dark:text-slate-400"
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {latest ? (
          <SyncOutcomeLine ev={latest} vocabulary={vocabulary} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
            <IconCircle className="h-4 w-4 shrink-0" stroke={1.75} />
            No syncs yet
          </span>
        )}
        {coverage && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {coverage}
          </span>
        )}
      </div>

      {latest && !latest.ok && latest.error && (
        <p
          className="mt-1 break-words text-sm text-rose-700 dark:text-rose-300"
          data-testid={`sync-error-${latest.id}`}
        >
          {latest.error}
        </p>
      )}
      {/* When the latest attempt failed, say when data last actually arrived — the
          question every reader of a red card has next. */}
      {latest && !latest.ok && state.lastSuccessAt && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Last successful sync{" "}
          <SyncTimestamp value={state.lastSuccessAt} relativeOnly />.
        </p>
      )}
      {latest && <SyncDetailsNotes ev={latest} />}
      {latest && written > 0 && provenance.has(latest.id) && (
        <SyncRowsDrilldown eventId={latest.id} count={written} />
      )}

      {(controls || (isAdmin && latest?.raw_ref)) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {controls}
          {isAdmin && latest?.raw_ref && (
            <div className="w-full">
              <RawPayloadViewer id={latest.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
