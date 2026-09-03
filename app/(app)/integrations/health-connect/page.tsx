import Link from "next/link";
import { PageHeader } from "@/components/ui";
import LeadFold from "@/components/LeadFold";
import PageContainer from "@/components/PageContainer";
import { getIntegration } from "@/lib/integrations/registry";
import {
  SOURCE_FIDELITY,
  type ExporterSetting,
} from "@/lib/integrations/health-connect";
import {
  getConnection,
  getHealthConnectCgmGlucose,
  getHealthConnectTokenInfo,
} from "@/lib/integrations/connections";
import { tokenLifecycleStatus } from "@/lib/token-lifecycle";
import { getIntegrationState, SETUP_HISTORY_LIMIT } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { getTimezone } from "@/lib/settings";
import { dateFromCreatedAt } from "@/lib/timeline-format";
import IntegrationStatusHeader from "@/components/integrations/IntegrationStatusHeader";
import SyncHistoryTable from "@/components/integrations/SyncHistoryTable";
import HealthConnectSetup from "./HealthConnectSetup";
import CgmGlucoseToggle from "./CgmGlucoseToggle";
import { requestNowMs } from "@/lib/request-now";
// The externally visible address of this deployment — one authority, shared with
// the calendar feed, Strava and Withings (#2959).
import { appUrl } from "@/lib/external-url-server";
import { getProfileAge } from "@/lib/settings";
import { isTrainingRelevant } from "@/lib/life-stage";
import BackLink from "@/components/BackLink";
import SetupStepsCard from "@/components/integrations/SetupStepsCard";

export const dynamic = "force-dynamic";

const INGEST_PATH = "/api/integrations/health-connect/ingest";

export default async function HealthConnectPage() {
  const { login, profile } = await requireSession();
  const nowMs = requestNowMs();
  const def = getIntegration("health-connect")!;
  const conn = getConnection(profile.id, "health-connect");
  const tokenInfo = getHealthConnectTokenInfo(profile.id);
  const connected = conn?.status === "connected" && tokenInfo.hasToken;
  const trainingRelevant = isTrainingRelevant(getProfileAge(profile.id));
  const endpoint = await appUrl(INGEST_PATH);
  // Lifecycle status for the DB-backed token (issue #24); the env fallback carries
  // no lifecycle, so it's always "active".
  const status = tokenLifecycleStatus(
    {
      hasToken: tokenInfo.source === "db",
      createdAt: tokenInfo.createdAt,
      expiresAt: tokenInfo.expiresAt,
    },
    nowMs
  );

  // THE per-source state (#1772): one computation behind this page, Review's
  // inbox, and the Integrations grid. The token card above answers a DIFFERENT
  // question (is the credential alive) and keeps its own lifecycle badge.
  const state = getIntegrationState(
    profile.id,
    "health-connect",
    SETUP_HISTORY_LIMIT
  )!;

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="integration-page"
    >
      <BackLink href="/data?section=import" label="Import" />

      <PageHeader title={def.name} />

      {/* One sentence, then the mechanics behind a fold (copy.md rule 10 /
          #3490). The registry carries the split; every integration page renders
          it the same way, so the intro cannot drift per source. */}
      <LeadFold
        lead={def.lead}
        detail={def.detail}
        summary="How it works"
        testId="integration-intro"
        className="mb-6"
      />

      <div className="grid gap-6">
        <HealthConnectSetup
          endpoint={endpoint}
          connected={connected}
          source={tokenInfo.source}
          envToken={tokenInfo.envToken}
          status={status}
          createdAt={tokenInfo.createdAt}
          lastUsedAt={tokenInfo.lastUsedAt}
          expiresOnDay={dateFromCreatedAt(
            tokenInfo.expiresAt,
            getTimezone(profile.id)
          )}
        />

        {connected && (
          <>
            <CgmGlucoseToggle
              initial={getHealthConnectCgmGlucose(profile.id)}
            />

            <SetupStepsCard
              title="Setup"
              steps={[
                <>
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
                </>,
                <>
                  Add a webhook with the <strong>Endpoint URL</strong> above and
                  an{" "}
                  <code className="rounded-sm bg-slate-100 px-1 py-0.5 text-xs dark:bg-ink-800">
                    Authorization
                  </code>{" "}
                  header of{" "}
                  <code className="rounded-sm bg-slate-100 px-1 py-0.5 text-xs dark:bg-ink-800">
                    Bearer &lt;token&gt;
                  </code>
                  .
                </>,
                <>
                  Choose a sync schedule (15–60 min interval and/or fixed
                  times). Each sync sends new records from a rolling 48-hour
                  window — re-sends are de-duplicated automatically.
                </>,
                <>
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
                    href={trainingRelevant ? "/training?tab=log" : "/history"}
                    className="text-brand-700 underline dark:text-brand-400"
                  >
                    {trainingRelevant ? "Training history" : "History"}
                  </Link>
                  .
                </>,
              ]}
              note={
                <>
                  Steps, distance, calories, and heart-rate detail sync into
                  Body Metrics charts. Nutrition works the same way: enable
                  Health Connect sync in a food tracker (MyFitnessPal,
                  Cronometer, Lose It!, Yazio, …) and your logged macros land on{" "}
                  <Link
                    href="/trends#body"
                    className="text-brand-700 underline dark:text-brand-400"
                  >
                    Trends → Nutrition → Macros
                  </Link>{" "}
                  — the supported path for food-log data, since those apps have
                  no usable direct API. Keep your token secret — anyone with it
                  can post data here.
                </>
              }
            />

            <div className="card">
              <IntegrationStatusHeader
                state={state}
                detail="period"
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

        <RecommendedSettings />
      </div>
    </PageContainer>
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
      className="card space-y-3 text-sm text-slate-600 dark:text-slate-300"
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
              <th className="th">Data type</th>
              <th className="th">Select</th>
              <th className="th">Why</th>
            </tr>
          </thead>
          <tbody>
            {SOURCE_FIDELITY.map((row) => (
              <tr
                key={row.label}
                className="border-b border-black/5 align-top dark:border-white/5"
              >
                <td className="td">{row.label}</td>
                <td className="td">
                  <code className="rounded-sm bg-slate-100 px-1 py-0.5 font-mono dark:bg-ink-800">
                    {SETTING_LABEL[row.setting]}
                  </code>
                </td>
                <td className="td text-slate-500 dark:text-slate-400">
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
