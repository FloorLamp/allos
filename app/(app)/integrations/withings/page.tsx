import Link from "next/link";
import { IconArrowLeft, IconCheck } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { getIntegration } from "@/lib/integrations/registry";
import {
  getConnection,
  getWithingsConfig,
} from "@/lib/integrations/connections";
import {
  getIntegrationSyncEvents,
  getLastSuccessfulSyncAt,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationDebugPanel from "@/components/IntegrationDebugPanel";
import { SecretField } from "../health-connect/HealthConnectConfig";
import { withingsCallbackUrl } from "./url";
import {
  saveWithingsCredentials,
  connectWithings,
  syncWithingsAction,
  disconnectWithingsAction,
} from "./actions";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  missing_code:
    "Withings didn't return an authorization code. Try connecting again.",
  state_mismatch:
    "Security check failed (state mismatch). Try connecting again.",
  missing_credentials: "Enter your Withings Client ID and Secret first.",
  token_exchange_failed:
    "Couldn't exchange the code for tokens. Check your Client ID/Secret.",
  access_denied: "You declined access on Withings.",
  sync_failed:
    "Sync failed. Check your connection to Withings and try again in a moment.",
  set_public_url:
    "This app's callback URL resolves to localhost, so Withings can't redirect back. Set the Public app URL in Settings → Server to the address this app is reachable at, then reconnect.",
};

export default async function WithingsPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const def = getIntegration("withings")!;
  const conn = getConnection(profile.id, "withings");
  const cfg = getWithingsConfig(profile.id);
  const hasCreds = !!(cfg.clientId && cfg.clientSecret);
  const connected = conn?.status === "connected" && !!cfg.accessToken;
  // The refresh token died/was revoked (issue #326) — surface an actionable notice.
  const needsReauth = conn?.status === "needs_reauth";
  const callbackUrl = await withingsCallbackUrl();
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

  const events = getIntegrationSyncEvents(profile.id, "withings");
  const lastSuccessAt = getLastSuccessfulSyncAt(profile.id, "withings");

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
        <div
          className="mb-4 max-w-3xl rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
          data-testid="withings-error"
        >
          {error}
        </div>
      )}

      {needsReauth && !connected && (
        <div
          className="mb-4 max-w-3xl rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
          data-testid="withings-needs-reauth"
        >
          Your Withings connection expired — the saved token was revoked or is
          no longer valid, so automatic syncing has stopped. Reconnect with
          Withings below to resume.
        </div>
      )}

      {connected ? (
        <div className="grid max-w-3xl gap-6">
          <div className="card space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                data-testid="withings-status"
              >
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
              <form action={syncWithingsAction}>
                <button className="btn">Sync now</button>
              </form>
              <form action={disconnectWithingsAction}>
                <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950">
                  Disconnect
                </button>
              </form>
            </div>
          </div>

          <SetupCard callbackUrl={callbackUrl} />

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
              Enter your Withings API application&rsquo;s{" "}
              <strong>Client ID</strong> and <strong>Client Secret</strong>.
              Register an app at{" "}
              <a
                href="https://developer.withings.com/dashboard/"
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 underline dark:text-brand-400"
              >
                developer.withings.com
              </a>{" "}
              and set its <strong>Callback URI</strong> to{" "}
              <code className="break-all rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-ink-800">
                {callbackUrl}
              </code>
              .
            </p>
            <form
              action={saveWithingsCredentials}
              className="grid gap-3"
              data-testid="withings-credentials-form"
            >
              <div>
                <label className="label" htmlFor="clientId">
                  Client ID
                </label>
                <input
                  id="clientId"
                  name="clientId"
                  className="input"
                  defaultValue={cfg.clientId ?? ""}
                  placeholder="Your Withings client ID"
                  autoComplete="off"
                  data-testid="withings-client-id"
                />
              </div>
              <div>
                <label className="label" htmlFor="clientSecret">
                  Client Secret
                </label>
                {/* Never echo the stored secret back into the page HTML. It is a
                    masked password field left blank; submitting blank keeps the
                    saved secret (see saveWithingsCredentials). */}
                <input
                  id="clientSecret"
                  name="clientSecret"
                  type="password"
                  className="input"
                  defaultValue=""
                  placeholder={
                    cfg.clientSecret
                      ? "•••••••••••• (leave blank to keep)"
                      : "Your Withings client secret"
                  }
                  autoComplete="off"
                  data-testid="withings-client-secret"
                />
              </div>
              <div>
                <button className="btn" data-testid="withings-save">
                  {hasCreds ? "Update credentials" : "Save credentials"}
                </button>
              </div>
            </form>

            {hasCreds && (
              <div className="border-t border-black/5 pt-4 dark:border-white/5">
                <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
                  Credentials saved. Connect your Withings account to start
                  syncing.
                </p>
                <form action={connectWithings}>
                  <button className="btn" data-testid="withings-connect">
                    Connect with Withings
                  </button>
                </form>
              </div>
            )}
          </div>

          <SetupCard callbackUrl={callbackUrl} />
        </div>
      )}
    </div>
  );
}

function SetupCard({ callbackUrl }: { callbackUrl: string }) {
  return (
    <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Setup
      </h2>
      <SecretField label="Callback URI" value={callbackUrl} />
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Register an application in the{" "}
          <a
            href="https://developer.withings.com/dashboard/"
            target="_blank"
            rel="noreferrer"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Withings developer dashboard
          </a>{" "}
          and set its <strong>Callback URI</strong> to the URL above.
        </li>
        <li>Paste the Client ID and Client Secret here and save.</li>
        <li>
          Click <strong>Connect with Withings</strong> and approve access.
          Measurements then sync automatically every hour, and you can press{" "}
          <strong>Sync now</strong> any time.
        </li>
        <li>
          Weight, body fat, and resting heart rate feed the{" "}
          <Link
            href="/trends?tab=body"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Body Metrics
          </Link>{" "}
          charts; blood pressure, SpO₂, and temperature land as{" "}
          <Link
            href="/trends?tab=biomarkers"
            className="text-brand-700 underline dark:text-brand-400"
          >
            vitals
          </Link>{" "}
          alongside manually-entered readings; sleep feeds the Body charts.
        </li>
      </ol>
    </div>
  );
}
