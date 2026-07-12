import Link from "next/link";
import { IconCheck, IconArrowRight } from "@tabler/icons-react";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { integrationDetailHref } from "@/lib/hrefs";
import { getConnection } from "@/lib/integrations/connections";
import { getLatestSyncEvent } from "@/lib/queries";
import RelativeTime from "./RelativeTime";

// The connect-card grid for the integration providers (Health Connect / Strava /
// Garmin). Shared by the Integrations page and the /import page's "connect a
// device or service" section so the two never drift. Profile-scoped
// connection status is read per card; the caller passes its active profile id.
export default function IntegrationsGrid({ profileId }: { profileId: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {INTEGRATIONS.map((it) => {
        const planned = it.status === "planned";
        const connected =
          !planned && getConnection(profileId, it.id)?.status === "connected";
        // Subtle last-sync / last-error hint from the profile-scoped debug log.
        const lastEvent = planned ? null : getLatestSyncEvent(profileId, it.id);
        const card = (
          <div
            className={`card h-full transition ${
              planned ? "opacity-70" : "hover:shadow-md"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                {it.name}
              </h2>
              {planned ? (
                <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                  Coming soon
                </span>
              ) : connected ? (
                <span className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                  <IconCheck className="h-3.5 w-3.5" /> Connected
                </span>
              ) : (
                <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  Not connected
                </span>
              )}
            </div>

            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {it.blurb}
            </p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {it.dataTypes.map((d) => (
                <span
                  key={d}
                  className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                >
                  {d}
                </span>
              ))}
            </div>

            {lastEvent && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
                {!lastEvent.ok && (
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-rose-500"
                    aria-label="Last sync failed"
                    title={lastEvent.error ?? "Last sync failed"}
                  />
                )}
                <span>
                  {lastEvent.ok ? "Last sync" : "Last attempt"}{" "}
                  <RelativeTime value={lastEvent.at} />
                </span>
              </div>
            )}

            {!planned && (
              <div className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700 dark:text-brand-400">
                {connected ? "Manage" : "Set up"}
                <IconArrowRight className="h-4 w-4" />
              </div>
            )}
          </div>
        );

        const detailHref = integrationDetailHref(it.id);
        return planned || !detailHref ? (
          <div key={it.id}>{card}</div>
        ) : (
          <Link key={it.id} href={detailHref}>
            {card}
          </Link>
        );
      })}
    </div>
  );
}
