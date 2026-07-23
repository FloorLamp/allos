import { headers } from "next/headers";
import Link from "next/link";
import {
  IconArrowLeft,
  IconCheck,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { getIntegration } from "@/lib/integrations/registry";
import {
  SOURCE_FIDELITY,
  type ExporterSetting,
} from "@/lib/integrations/health-connect";
import {
  getConnection,
  getHealthConnectTokenInfo,
} from "@/lib/integrations/connections";
import { getPublicUrl } from "@/lib/settings";
import { tokenLifecycleStatus } from "@/lib/token-lifecycle";
import {
  getIntegrationSyncEvents,
  getLastSuccessfulSyncAt,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationDebugPanel from "@/components/IntegrationDebugPanel";
import { ExpirySelect, TokenLifecycleNote } from "@/components/TokenLifecycle";
import { TokenRow } from "@/components/TokenRow";
import { connectHealthConnect, disconnect } from "./actions";

export const dynamic = "force-dynamic";

const INGEST_PATH = "/api/integrations/health-connect/ingest";

// Configured public URL (Settings → Public app URL) when set, else derived
// from the request headers (same logic as the Strava url helper).
async function baseUrl(): Promise<string> {
  const configured = getPublicUrl();
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export default async function HealthConnectPage() {
  const { profile } = await requireSession();
  const def = getIntegration("health-connect")!;
  const conn = getConnection(profile.id, "health-connect");
  const tokenInfo = getHealthConnectTokenInfo(profile.id);
  const token = tokenInfo.token;
  const connected = conn?.status === "connected" && !!token;
  const endpoint = `${await baseUrl()}${INGEST_PATH}`;
  // Lifecycle status for the DB-backed token (issue #24); the env fallback carries
  // no lifecycle, so it's always "active".
  const status = tokenLifecycleStatus(
    {
      hasToken: tokenInfo.source === "db",
      createdAt: tokenInfo.createdAt,
      expiresAt: tokenInfo.expiresAt,
    },
    Date.now()
  );

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
          <form action={connectHealthConnect} className="space-y-3">
            <div className="max-w-xs">
              <ExpirySelect />
            </div>
            <button className="btn">Generate token & enable</button>
          </form>
        </div>
      ) : (
        <div className="grid max-w-3xl gap-6">
          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              {status === "expired" ? (
                <span
                  className="badge inline-flex items-center gap-1 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                  data-testid="health-connect-status"
                >
                  <IconAlertTriangle className="h-3.5 w-3.5" /> Expired
                </span>
              ) : (
                <span
                  className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                  data-testid="health-connect-status"
                >
                  <IconCheck className="h-3.5 w-3.5" /> Connected
                </span>
              )}
              {conn?.last_sync_at && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Last sync: {conn.last_sync_at} UTC
                </span>
              )}
            </div>

            <TokenRow label="Endpoint URL" value={endpoint} />
            <TokenRow label="Bearer token" value={token!} secret />

            {tokenInfo.source === "db" ? (
              <TokenLifecycleNote
                status={status}
                createdAt={tokenInfo.createdAt}
                lastUsedAt={tokenInfo.lastUsedAt}
                expiresAt={tokenInfo.expiresAt}
              />
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                This token comes from the{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-ink-800">
                  HEALTH_CONNECT_TOKEN
                </code>{" "}
                environment fallback — it has no expiry or last-used tracking.
                Rotate below to switch to a managed, DB-backed token.
              </p>
            )}

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

            <div className="flex flex-wrap items-end gap-3 border-t border-black/5 pt-4 dark:border-white/5">
              <form
                action={connectHealthConnect}
                className="flex flex-wrap items-end gap-3"
              >
                <div className="w-40">
                  <ExpirySelect />
                </div>
                <button
                  className="rounded-lg border border-black/10 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
                  data-testid="health-connect-rotate"
                >
                  Rotate token
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
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Steps, distance, calories, and heart-rate detail sync into Body
              Metrics charts. Nutrition works the same way: enable Health
              Connect sync in a food tracker (MyFitnessPal, Cronometer, Lose
              It!, Yazio, …) and your logged macros land on{" "}
              <Link
                href="/trends?tab=body"
                className="text-brand-700 underline dark:text-brand-400"
              >
                Trends → Body → Macros
              </Link>{" "}
              — the supported path for food-log data, since those apps have no
              usable direct API. Keep your token secret — anyone with it can
              post data here.
            </p>
          </div>

          <IntegrationDebugPanel
            events={events}
            lastSuccessAt={lastSuccessAt}
            connected={connected}
          />
        </div>
      )}

      <RecommendedSettings />
    </div>
  );
}

// The per-type granularity guidance (issue #1065), rendered from the single
// SOURCE_FIDELITY source of truth so the card and the parser (and the at-ingest
// detectors) can never disagree about what to recommend. Shown in both the connected
// and disconnected states, since it's most useful while setting the exporter up.
const SETTING_LABEL: Record<ExporterSetting, string> = {
  daily: "daily",
  full: "full",
  "1m": "1m",
  off: "off",
};

function RecommendedSettings() {
  return (
    <div
      className="card mt-6 max-w-3xl space-y-3 text-sm text-slate-600 dark:text-slate-300"
      data-testid="hc-recommended-settings"
    >
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Recommended settings
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The exporter app lets you set each data type&rsquo;s granularity (daily
        / full / 1m / 5m / 15m). Pick these so Allos gets the resolution it
        stores at — too fine bloats the payload (and risks rejection), too
        coarse starves the charts.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-black/10 dark:border-white/10">
              <th className="py-1.5 pr-3 font-medium">Data type</th>
              <th className="py-1.5 pr-3 font-medium">Select</th>
              <th className="py-1.5 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {SOURCE_FIDELITY.map((row) => (
              <tr
                key={row.label}
                className="border-b border-black/5 align-top dark:border-white/5"
              >
                <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-200">
                  {row.label}
                </td>
                <td className="py-1.5 pr-3">
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono dark:bg-ink-800">
                    {SETTING_LABEL[row.setting]}
                  </code>
                </td>
                <td className="py-1.5 text-slate-500 dark:text-slate-400">
                  {row.why}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
