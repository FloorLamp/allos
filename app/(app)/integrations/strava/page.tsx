import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import { Notice } from "@/components/Notice";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection, getStravaConfig } from "@/lib/integrations/connections";
import { getIntegrationState, SETUP_HISTORY_LIMIT } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationStatusHeader from "@/components/integrations/IntegrationStatusHeader";
import SyncHistoryTable from "@/components/integrations/SyncHistoryTable";
import SyncNowButton from "@/components/SyncNowButton";
import { TokenRow } from "@/components/TokenRow";
import { baseUrl, stravaCallbackUrl } from "./url";
import {
  saveStravaCredentials,
  connectStrava,
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
  set_public_url:
    "This app's callback URL resolves to localhost, so Strava can't redirect back. Set the Public app URL in Settings → Server to the address this app is reachable at, then reconnect.",
};

export default async function StravaPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { login, profile } = await requireSession();
  const def = getIntegration("strava")!;
  const conn = getConnection(profile.id, "strava");
  const cfg = getStravaConfig(profile.id);
  const hasCreds = !!(cfg.clientId && cfg.clientSecret);
  const connected = conn?.status === "connected" && !!cfg.accessToken;
  // The refresh token died/was revoked (issue #326): show an actionable notice above
  // the reconnect form instead of leaving the user with a silent, forever-failing sync.
  const needsReauth = conn?.status === "needs_reauth";
  const callbackUrl = await stravaCallbackUrl();
  const callbackDomain = new URL(await baseUrl()).host;
  const error = searchParams.error
    ? (ERROR_MESSAGES[searchParams.error] ?? "Couldn't connect. Try again.")
    : null;

  // THE per-provider state (#1772) — the same computation Review's inbox and the
  // Integrations grid read, so the three can no longer describe this provider
  // differently. The raw `last_sync_summary` key:value echo this page used to render
  // (a third accounting, with no formatter) is retired in favour of it.
  const state = getIntegrationState(profile.id, "strava", SETUP_HISTORY_LIMIT)!;

  return (
    <PageContainer width="reading" className="mx-auto">
      <Link
        href="/data?section=import"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <IconArrowLeft className="h-4 w-4" /> Import
      </Link>

      <PageHeader title={def.name} subtitle={def.blurb} />

      {error && (
        <Notice tone="rose" className="mb-4 max-w-3xl">
          {error}
        </Notice>
      )}

      {needsReauth && !connected && (
        <Notice
          tone="rose"
          testid="strava-needs-reauth"
          className="mb-4 max-w-3xl"
        >
          Your Strava connection expired — the saved token was revoked or is no
          longer valid, so automatic syncing has stopped. Reconnect with Strava
          below to resume.
        </Notice>
      )}

      {connected ? (
        <div className="grid gap-6">
          <div className="card">
            <IntegrationStatusHeader
              state={state}
              detail="period"
              isAdmin={login.role === "admin"}
              controls={
                <>
                  <SyncNowButton provider="strava" />
                  <form action={disconnectStravaAction}>
                    <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950">
                      Disconnect
                    </button>
                  </form>
                </>
              }
            />
          </div>

          <SetupCard
            callbackUrl={callbackUrl}
            callbackDomain={callbackDomain}
          />

          <SyncHistoryTable state={state} isAdmin={login.role === "admin"} />
        </div>
      ) : (
        <div className="grid gap-6">
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
    </PageContainer>
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
      <TokenRow label="Authorization Callback Domain" value={callbackDomain} />
      <TokenRow label="Callback URL" value={callbackUrl} />
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
            href="/trends#body"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Body metrics
          </Link>{" "}
          energy chart.
        </li>
      </ol>
    </div>
  );
}
