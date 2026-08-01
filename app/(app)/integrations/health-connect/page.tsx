import { headers } from "next/headers";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
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
import { getIntegrationState, SETUP_HISTORY_LIMIT } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationStatusHeader from "@/components/integrations/IntegrationStatusHeader";
import SyncHistoryTable from "@/components/integrations/SyncHistoryTable";
import HealthConnectSetup from "./HealthConnectSetup";

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
  const { login, profile } = await requireSession();
  const def = getIntegration("health-connect")!;
  const conn = getConnection(profile.id, "health-connect");
  const tokenInfo = getHealthConnectTokenInfo(profile.id);
  const connected = conn?.status === "connected" && tokenInfo.hasToken;
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

  // THE per-provider state (#1772): one computation behind this page, Review's
  // inbox, and the Integrations grid. The token card above answers a DIFFERENT
  // question (is the credential alive) and keeps its own lifecycle badge.
  const state = getIntegrationState(
    profile.id,
    "health-connect",
    SETUP_HISTORY_LIMIT
  )!;

  return (
    <div>
      <Link
        href="/data?section=import"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <IconArrowLeft className="h-4 w-4" /> Import
      </Link>

      <PageHeader title={def.name} subtitle={def.blurb} />

      <div className="grid max-w-3xl gap-6">
        <HealthConnectSetup
          endpoint={endpoint}
          connected={connected}
          source={tokenInfo.source}
          envToken={tokenInfo.envToken}
          status={status}
          createdAt={tokenInfo.createdAt}
          lastUsedAt={tokenInfo.lastUsedAt}
          expiresAt={tokenInfo.expiresAt}
        />

        {connected && (
          <>
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
                  installed) and grant it the health permissions you want to
                  sync.
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
                  Choose a sync schedule (15–60 min interval and/or fixed
                  times). Each sync sends new records from a rolling 48-hour
                  window — re-sends are de-duplicated automatically.
                </li>
                <li>
                  Tap <strong>Sync Now</strong> to test. Imported weight, body
                  fat, and resting HR appear under{" "}
                  <Link
                    href="/trends#body"
                    className="text-brand-700 underline dark:text-brand-400"
                  >
                    Body metrics
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
                  href="/trends#body"
                  className="text-brand-700 underline dark:text-brand-400"
                >
                  Trends → Body → Macros
                </Link>{" "}
                — the supported path for food-log data, since those apps have no
                usable direct API. Keep your token secret — anyone with it can
                post data here.
              </p>
            </div>

            <div className="card">
              <IntegrationStatusHeader
                state={state}
                isAdmin={login.role === "admin"}
                controls={
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Push-only — your phone&apos;s exporter sends data on a
                    schedule; there&apos;s nothing to sync by hand.
                  </span>
                }
              />
            </div>

            <SyncHistoryTable state={state} isAdmin={login.role === "admin"} />
          </>
        )}
      </div>

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
