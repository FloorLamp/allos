import { headers } from "next/headers";
import Link from "next/link";
import { IconArrowLeft, IconCheck } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { getIntegration } from "@/lib/integrations/registry";
import {
  getConnection,
  getHealthConnectToken,
} from "@/lib/integrations/connections";
import { getPublicUrl } from "@/lib/settings";
import {
  getIntegrationSyncEvents,
  getLastSuccessfulSyncAt,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationDebugPanel from "@/components/IntegrationDebugPanel";
import { SecretField } from "./HealthConnectConfig";
import { connectHealthConnect, disconnect } from "./actions";

export const dynamic = "force-dynamic";

const INGEST_PATH = "/api/integrations/health-connect/ingest";

// Configured public URL (Settings → Public app URL) when set, else derived
// from the request headers (same logic as the Strava url helper).
function baseUrl(): string {
  const configured = getPublicUrl();
  if (configured) return configured;
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export default function HealthConnectPage() {
  const { profile } = requireSession();
  const def = getIntegration("health-connect")!;
  const conn = getConnection(profile.id, "health-connect");
  const token = getHealthConnectToken(profile.id);
  const connected = conn?.status === "connected" && !!token;
  const endpoint = `${baseUrl()}${INGEST_PATH}`;

  let lastSummary: Record<string, number> | null = null;
  try {
    lastSummary = conn?.last_sync_summary
      ? JSON.parse(conn.last_sync_summary)
      : null;
  } catch {
    lastSummary = null;
  }

  // Profile-scoped sync-event history for the debug panel.
  const events = getIntegrationSyncEvents(profile.id, "health-connect");
  const lastSuccessAt = getLastSuccessfulSyncAt(profile.id, "health-connect");

  return (
    <div>
      <Link
        href="/data?section=import"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <IconArrowLeft className="h-4 w-4" /> Import
      </Link>

      <PageHeader title={def.name} subtitle={def.blurb} />

      {!connected ? (
        <div className="card max-w-2xl space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Generate a token to enable the ingest endpoint, then paste it into
            the exporter app on your phone.
          </p>
          <form action={connectHealthConnect}>
            <button className="btn">Generate token & enable</button>
          </form>
        </div>
      ) : (
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

            <SecretField label="Endpoint URL" value={endpoint} />
            <SecretField label="Bearer token" value={token!} secret />

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
              <form action={connectHealthConnect}>
                <button className="rounded-lg border border-black/10 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800">
                  Regenerate token
                </button>
              </form>
              <form action={disconnect}>
                <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950">
                  Disconnect
                </button>
              </form>
            </div>
          </div>

          <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Setup
            </h2>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Install{" "}
                <a
                  href={def.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 underline dark:text-brand-400"
                >
                  Health Connect Webhook
                </a>{" "}
                on your Android phone (Android 14+, with Health Connect
                installed) and grant it the health permissions you want to sync.
              </li>
              <li>
                Add a webhook with the <strong>Endpoint URL</strong> above and
                an{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-ink-800">
                  Authorization
                </code>{" "}
                header of{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-ink-800">
                  Bearer &lt;token&gt;
                </code>
                .
              </li>
              <li>
                Choose a sync schedule (15–60 min interval and/or fixed times).
                Each sync sends new records from a rolling 48-hour window —
                re-sends are de-duplicated automatically.
              </li>
              <li>
                Tap <strong>Sync Now</strong> to test. Imported weight, body
                fat, and resting HR appear under{" "}
                <Link
                  href="/trends?tab=body"
                  className="text-brand-700 underline dark:text-brand-400"
                >
                  Body Metrics
                </Link>
                ; workouts under{" "}
                <Link
                  href="/training?tab=log"
                  className="text-brand-700 underline dark:text-brand-400"
                >
                  Training history
                </Link>
                .
              </li>
            </ol>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Steps, distance, calories, and heart-rate detail sync into Body
              Metrics charts. Keep your token secret — anyone with it can post
              data here.
            </p>
          </div>

          <IntegrationDebugPanel
            events={events}
            lastSuccessAt={lastSuccessAt}
            connected={connected}
          />
        </div>
      )}
    </div>
  );
}
