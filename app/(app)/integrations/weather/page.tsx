import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import { Notice } from "@/components/Notice";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection } from "@/lib/integrations/connections";
import { getIntegrationState, SETUP_HISTORY_LIMIT } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { getHomeLocation, getSkinType } from "@/lib/settings";
import { today } from "@/lib/db";
import { getUvDoseForDay } from "@/lib/queries/weather";
import IntegrationStatusHeader from "@/components/integrations/IntegrationStatusHeader";
import SyncHistoryTable from "@/components/integrations/SyncHistoryTable";
import SyncNowButton from "@/components/SyncNowButton";
import { enableWeatherAction, disconnectWeatherAction } from "./actions";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  no_location:
    "Set your home location first (Settings → Profile) — the UV series is fetched for that spot.",
};

export default async function WeatherPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { login, profile } = await requireSession();
  const def = getIntegration("weather")!;
  const conn = getConnection(profile.id, "weather");
  const connected = conn?.status === "connected";
  const home = getHomeLocation(profile.id);
  const skinType = getSkinType(profile.id);
  const error = searchParams.error
    ? (ERROR_MESSAGES[searchParams.error] ?? "Something went wrong. Try again.")
    : null;

  // THE per-provider state (#1772): one computation behind this page, Review's
  // inbox, and the Integrations grid. Weather speaks the CACHE vocabulary — its
  // counts are revised forecast cells, not user records — which the shared
  // formatter derives from the provider kind.
  const state = getIntegrationState(
    profile.id,
    "weather",
    SETUP_HISTORY_LIMIT
  )!;
  const dose = connected
    ? getUvDoseForDay(profile.id, today(profile.id))
    : null;

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
        <Notice tone="rose" testid="weather-error" className="mb-4 max-w-3xl">
          {error}
        </Notice>
      )}

      <PageContainer width="reading" className="grid gap-6">
        <div className="card space-y-4">
          {!home ? (
            <div className="space-y-3">
              <span
                className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                data-testid="weather-status"
              >
                Home location needed
              </span>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                This integration needs no account or API key — just your home
                location, so it knows where to fetch the UV for. Set it on{" "}
                <Link
                  href="/settings/health"
                  className="text-brand-700 underline dark:text-brand-400"
                >
                  Settings → Profile
                </Link>
                , then come back and enable it.
              </p>
            </div>
          ) : connected ? (
            <>
              <IntegrationStatusHeader
                state={state}
                isAdmin={login.role === "admin"}
                controls={
                  <>
                    <SyncNowButton provider="weather" />
                    <form action={disconnectWeatherAction}>
                      <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950">
                        Disable
                      </button>
                    </form>
                  </>
                }
              />

              {dose && dose.outdoorMinutes > 0 && (
                <div data-testid="weather-today-dose">
                  <label className="label">Today so far</label>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                      {dose.outdoorMinutes} min outdoors
                    </span>
                    {dose.uvMinutes != null && (
                      <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                        {dose.uvMinutes} UV-min
                      </span>
                    )}
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                      {dose.uvSource === "live"
                        ? "live UV"
                        : "clear-sky estimate"}
                    </span>
                  </div>
                </div>
              )}

              {!skinType && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Add your skin type on{" "}
                  <Link
                    href="/settings/health"
                    className="text-brand-700 underline dark:text-brand-400"
                  >
                    Settings → Profile
                  </Link>{" "}
                  to turn on the overexposure (burn-risk) heads-up. Without it,
                  only the &ldquo;enough sun&rdquo; side is shown.
                </p>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <span
                className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                data-testid="weather-status"
              >
                Not enabled
              </span>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Enable to fetch the hourly UV index and solar irradiance for
                your home location. No API key or account — powered by
                Open-Meteo, and its free historical archive backfills the UV for
                activities you already logged.
              </p>
              <form action={enableWeatherAction}>
                <button className="btn" data-testid="weather-enable">
                  Enable weather &amp; UV
                </button>
              </form>
            </div>
          )}
        </div>

        <SetupCard />

        {connected && (
          <SyncHistoryTable state={state} isAdmin={login.role === "admin"} />
        )}
      </PageContainer>
    </div>
  );
}

function SetupCard() {
  return (
    <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        How it works
      </h2>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Set your coarse home location on{" "}
          <Link
            href="/settings/health"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Settings → Profile
          </Link>{" "}
          (stored at ~11 km precision — city scale, never a street address).
        </li>
        <li>
          Enable here. The hourly UV index + solar irradiance for that spot sync
          automatically every hour via{" "}
          <a
            href="https://open-meteo.com/"
            target="_blank"
            rel="noreferrer"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Open-Meteo
          </a>{" "}
          — no API key or account.
        </li>
        <li>
          Your outdoor daylight time then becomes a two-sided UV dose: enough
          for vitamin D and circadian light, with a heads-up before you&rsquo;d
          burn (add your skin type to switch on the burn side).
        </li>
        <li>
          Offline or before the first sync, sun features still work from a
          clear-sky estimate — the UV layer only enhances them.
        </li>
      </ol>
    </div>
  );
}
