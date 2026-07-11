import Link from "next/link";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircle,
} from "@tabler/icons-react";
import type { IntegrationSyncEvent } from "@/lib/types";
import type { ConnectedSource } from "@/lib/queries/integrations";
import { formatSplitLabel, formatWindow } from "@/lib/integrations/sync-log";
import RelativeTime from "@/components/RelativeTime";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import SyncNowButton from "@/components/SyncNowButton";

// Data → Review, "Connected sources" (issue #208): the RECURRING import streams —
// Health Connect, Strava — where the question is "is it healthy now", so each
// provider collapses to ONE latest-state card (outcome + relative time + the
// new/changed/unchanged split) with an expandable recent history, an admin raw-
// payload viewer, and a per-provider "Sync now" (Strava) or a push explainer (HC).
// This is the correct home for the "resync" intent — contrast the chronological
// one-off Imports feed (<ImportFeed>). Server component — the page reads the sources
// via lib/queries (getConnectedSources) and hands them in.

function StateLine({ ev }: { ev: IntegrationSyncEvent }) {
  const { primary, muted } = formatSplitLabel(ev);
  const Icon = ev.ok ? IconCircleCheck : IconAlertTriangle;
  const skipped = ev.skipped ?? 0;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <Icon
        className={`h-4 w-4 shrink-0 ${ev.ok ? "text-emerald-500" : "text-rose-500"}`}
        stroke={1.75}
      />
      <span
        className={
          ev.ok
            ? muted
              ? "text-slate-400 dark:text-slate-500"
              : "text-slate-700 dark:text-slate-200"
            : "font-medium text-rose-700 dark:text-rose-300"
        }
      >
        {ev.ok ? primary : "Sync failed"}
      </span>
      {/* ev.ok is a NUMBER (0/1) — a bare `ev.ok &&` would render a literal "0"
          on failure lines, so coerce it. */}
      {ev.ok !== 0 && skipped > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          · {skipped} skipped
        </span>
      )}
    </span>
  );
}

function SourceCard({
  source,
  isAdmin,
}: {
  source: ConnectedSource;
  isAdmin: boolean;
}) {
  const { latest, history } = source;
  return (
    <li
      className="rounded-lg border border-black/5 p-3 dark:border-white/5"
      data-testid={`source-${source.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-800 dark:text-slate-100">
            {source.name}
          </span>
          {source.connected ? (
            <span className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
              Connected
            </span>
          ) : source.needsReauth ? (
            // The credential died (dead/revoked token) — a distinct, actionable state
            // from the benign "Not connected" (issue #326).
            <span className="badge inline-flex items-center gap-1 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
              <IconAlertTriangle className="h-3.5 w-3.5" /> Needs reconnect
            </span>
          ) : (
            <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              Not connected
            </span>
          )}
        </div>
        {latest && (
          <RelativeTime
            value={latest.at}
            className="text-xs text-slate-400 dark:text-slate-500"
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {latest ? (
          <StateLine ev={latest} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-slate-400 dark:text-slate-500">
            <IconCircle className="h-4 w-4 shrink-0" stroke={1.75} />
            No syncs yet
          </span>
        )}
        {latest?.window_start && (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {formatWindow(latest.window_start, latest.window_end)}
          </span>
        )}
      </div>

      {latest && !latest.ok && latest.error && (
        <p className="mt-1 break-words text-sm text-rose-700 dark:text-rose-300">
          {latest.error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {source.canSyncNow ? (
          source.connected ? (
            <SyncNowButton provider={source.id} />
          ) : (
            // A pull source only appears here once it's been set up, so a
            // not-connected card is one that was connected and later removed
            // (issue #294) OR one whose token died and flipped to needs_reauth
            // (#326): either way, offer a Reconnect link back to its setup page.
            <Link
              href={`/integrations/${source.id}`}
              className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              Reconnect {source.name} →
            </Link>
          )
        ) : (
          // Push-only providers (Health Connect) can't be pulled on demand — the
          // phone exporter drives them on its own schedule.
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Push-only — your phone&apos;s exporter sends data on a schedule;
            there&apos;s nothing to sync by hand.
          </span>
        )}
        {isAdmin && latest?.raw_ref && (
          <div className="w-full">
            <RawPayloadViewer id={latest.id} />
          </div>
        )}
      </div>

      {history.length > 1 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
            Recent syncs ({history.length})
          </summary>
          <ul className="mt-2 space-y-1.5 border-l border-black/5 pl-3 dark:border-white/10">
            {history.map((ev) => (
              <li key={ev.id} className="text-xs">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <RelativeTime
                    value={ev.at}
                    className="text-slate-400 dark:text-slate-500"
                  />
                  <StateLine ev={ev} />
                  {ev.window_start && (
                    <span className="text-slate-400 dark:text-slate-500">
                      {formatWindow(ev.window_start, ev.window_end)}
                    </span>
                  )}
                </div>
                {isAdmin && ev.raw_ref && <RawPayloadViewer id={ev.id} />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export default function ConnectedSources({
  sources,
  isAdmin = false,
}: {
  sources: ConnectedSource[];
  isAdmin?: boolean;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="card" data-testid="connected-sources">
      <div className="mb-1">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Connected sources
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Devices and services that sync automatically — each showing its latest
          state. Expand a source for its recent sync history.
        </p>
      </div>
      <ul className="mt-3 space-y-3">
        {sources.map((source) => (
          <SourceCard key={source.id} source={source} isAdmin={isAdmin} />
        ))}
      </ul>
    </div>
  );
}
