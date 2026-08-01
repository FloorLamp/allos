import Link from "next/link";
import { IconCheck, IconArrowRight } from "@tabler/icons-react";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { integrationDetailHref } from "@/lib/hrefs";
import { getIntegrationState } from "@/lib/queries";
import { standingBadge } from "@/lib/integrations/provider-state";
import StatusBadge from "./integrations/StatusBadge";
import SyncTimestamp from "./integrations/SyncTimestamp";

// The connect-card grid for the integration providers (Health Connect / Strava /
// Garmin). Shared by the Integrations page and the /import page's "connect a
// device or service" section so the two never drift. Profile-scoped
// connection status is read per card; the caller passes its active profile id.
//
// It is the third surface that answers "what's the state of this integration", so it
// reads the SAME state model as the setup page and Review's inbox (#1772) — one badge
// vocabulary, one timestamp treatment. It asks for no history (the card shows none),
// so the read is the connection plus two indexed seeks.
export default function IntegrationsGrid({ profileId }: { profileId: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {INTEGRATIONS.map((it) => {
        const planned = it.status === "planned";
        const state = planned ? null : getIntegrationState(profileId, it.id, 0);
        const connected = !!state?.connected;
        const badge = state ? standingBadge(state.standing) : null;
        // Subtle last-sync / last-error hint from the profile-scoped debug log.
        const lastEvent = state?.latest ?? null;
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
              {planned || !badge ? (
                <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                  Coming soon
                </span>
              ) : (
                <StatusBadge
                  label={badge.label}
                  tone={badge.tone}
                  icon={
                    badge.tone === "good" ? (
                      <IconCheck className="h-3.5 w-3.5" />
                    ) : undefined
                  }
                />
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
              <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                {!lastEvent.ok && (
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-rose-500"
                    aria-label="Last sync failed"
                    title={lastEvent.error ?? "Last sync failed"}
                  />
                )}
                <span>
                  {lastEvent.ok ? "Last sync" : "Last attempt"}{" "}
                  <SyncTimestamp value={lastEvent.at} relativeOnly />
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
