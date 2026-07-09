import Link from "next/link";
import { IconArrowLeft, IconCheck } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection, getStravaConfig } from "@/lib/integrations/connections";
import {
  getIntegrationSyncEvents,
  getLastSuccessfulSyncAt,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationDebugPanel from "@/components/IntegrationDebugPanel";
import { SecretField } from "../health-connect/HealthConnectConfig";
import { baseUrl, stravaCallbackUrl } from "./url";
import {
  saveStravaCredentials,
  connectStrava,
  syncStravaAction,
  disconnectStravaAction,
} from "./actions";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  missing_code:
    "Strava didn't return an authorization code. Try connecting again.",
  state_mismatch:
    "Security check failed (state mismatch). Try connecting again.",
  missing_credentials: "Enter your Strava Client ID and Secret first.",
  token_exchange_failed:
    "Couldn't exchange the code for tokens. Check your Client ID/Secret.",
  access_denied: "You declined access on Strava.",
  sync_failed:
    "Sync failed. Check your connection to Strava and try again in a moment.",
  set_public_url:
    "This app's callback URL resolves to localhost, so Strava can't redirect back. Set the Public app URL in Settings → Server to the address this app is reachable at, then reconnect.",
};

export default function StravaPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const { profile } = requireSession();
  const def = getIntegration("strava")!;
  const conn = getConnection(profile.id, "strava");
  const cfg = getStravaConfig(profile.id);
  const hasCreds = !!(cfg.clientId && cfg.clientSecret);
  const connected = conn?.status === "connected" && !!cfg.accessToken;
  const callbackUrl = stravaCallbackUrl();
  const callbackDomain = new URL(baseUrl()).host;
  const error = searchParams.error
    ? (ERROR_MESSAGES[searchParams.error] ?? "Connection failed. Try again.")
    : null;

  let lastSummary: Record<string, number> | null = null;
  try {
    lastSummary = conn?.last_sync_summary
      ? JSON.parse(conn.last_sync_summary)
      : null;
  } catch {
    lastSummary = null;
  }

  // Profile-scoped sync-event history for the debug panel.
  const events = getIntegrationSyncEvents(profile.id, "strava");
  const lastSuccessAt = getLastSuccessfulSyncAt(profile.id, "strava");

  return (
    <div>
      <Link
        href="/data?section=import"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <IconArrowLeft className="h-4 w-4" /> Import
      </Link>

      <PageHeader title={def.name} subtitle={def.blurb} />

      {error && (
        <div className="mb-4 max-w-3xl rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
          {error}
        </div>
      )}

      {connected ? (
        <div className="grid max-w-3xl gap-6">
          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <span className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                <IconCheck className="h-3.5 w-3.5" /> Connected
              </span>
              {conn?.last_sync_at && (
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  Last sync: {conn.last_sync_at} UTC
                </span>
              )}
            </div>

            {lastSummary && (
              <div>
                <label className="label">Last sync</label>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(lastSummary).map(([k, v]) => (
                    <span
                      key={k}
                      className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                    >
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <form action={syncStravaAction}>
                <button className="btn">Sync now</button>
              </form>
              <form action={disconnectStravaAction}>
                <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950">
                  Disconnect
                </button>
              </form>
            </div>
          </div>

          <SetupCard
            callbackUrl={callbackUrl}
            callbackDomain={callbackDomain}
          />

          <IntegrationDebugPanel
            events={events}
            lastSuccessAt={lastSuccessAt}
            connected={connected}
          />
        </div>
      ) : (
        <div className="grid max-w-3xl gap-6">
          <div className="card space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Enter your Strava API application&rsquo;s{" "}
              <strong>Client ID</strong> and <strong>Client Secret</strong>.
              Create an app at{" "}
              <a
                href="https://www.strava.com/settings/api"
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 underline dark:text-brand-400"
              >
                strava.com/settings/api
              </a>{" "}
              and set its <strong>Authorization Callback Domain</strong> to{" "}
              <code className="break-all rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-ink-800">
                {callbackDomain}
              </code>
              .
            </p>
            <form action={saveStravaCredentials} className="grid gap-3">
              <div>
                <label className="label" htmlFor="clientId">
                  Client ID
                </label>
                <input
                  id="clientId"
                  name="clientId"
                  className="input"
                  defaultValue={cfg.clientId ?? ""}
                  placeholder="12345"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="label" htmlFor="clientSecret">
                  Client Secret
                </label>
                {/* Never echo the stored secret back into the page HTML. It is a
                    masked password field left blank; submitting blank keeps the
                    saved secret (see saveStravaCredentials). */}
                <input
                  id="clientSecret"
                  name="clientSecret"
                  type="password"
                  className="input"
                  defaultValue=""
                  placeholder={
                    cfg.clientSecret
                      ? "•••••••••••• (leave blank to keep)"
                      : "Your Strava client secret"
                  }
                  autoComplete="off"
                />
              </div>
              <div>
                <button className="btn">
                  {hasCreds ? "Update credentials" : "Save credentials"}
                </button>
              </div>
            </form>

            {hasCreds && (
              <div className="border-t border-black/5 pt-4 dark:border-white/5">
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
                  Credentials saved. Connect your Strava account to start
                  syncing.
                </p>
                <form action={connectStrava}>
                  <button className="btn">Connect with Strava</button>
                </form>
              </div>
            )}
          </div>

          <SetupCard
            callbackUrl={callbackUrl}
            callbackDomain={callbackDomain}
          />
        </div>
      )}
    </div>
  );
}

function SetupCard({
  callbackUrl,
  callbackDomain,
}: {
  callbackUrl: string;
  callbackDomain: string;
}) {
  return (
    <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Setup
      </h2>
      <SecretField
        label="Authorization Callback Domain"
        value={callbackDomain}
      />
      <SecretField label="Callback URL" value={callbackUrl} />
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Create an application at{" "}
          <a
            href="https://www.strava.com/settings/api"
            target="_blank"
            rel="noreferrer"
            className="text-brand-700 underline dark:text-brand-400"
          >
            strava.com/settings/api
          </a>{" "}
          and set its <strong>Authorization Callback Domain</strong> to the
          domain above.
        </li>
        <li>Paste the Client ID and Client Secret here and save.</li>
        <li>
          Click <strong>Connect with Strava</strong> and approve access.
          Activities then sync automatically every hour, and you can press{" "}
          <strong>Sync now</strong> any time.
        </li>
        <li>
          Imported runs, rides, and workouts appear under{" "}
          <Link
            href="/training?tab=log"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Training history
          </Link>
          ; calories feed the{" "}
          <Link
            href="/trends?tab=body"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Body Metrics
          </Link>{" "}
          energy chart.
        </li>
      </ol>
    </div>
  );
}
