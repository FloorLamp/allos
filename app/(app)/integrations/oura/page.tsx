import Link from "next/link";
import { IconArrowLeft, IconCheck } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection, getOuraConfig } from "@/lib/integrations/connections";
import {
  getIntegrationSyncEvents,
  getLastSuccessfulSyncAt,
} from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationDebugPanel from "@/components/IntegrationDebugPanel";
import { connectOura, syncOuraAction, disconnectOuraAction } from "./actions";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  missing_token: "Paste your Oura personal access token first.",
  invalid_token:
    "Oura rejected that token (401). Check you copied the whole personal access token, then try again.",
  validation_failed:
    "Couldn't reach Oura to validate the token. Check your connection and try again in a moment.",
  sync_failed:
    "Sync failed. Check your connection to Oura and try again in a moment.",
};

export default async function OuraPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const def = getIntegration("oura")!;
  const conn = getConnection(profile.id, "oura");
  const cfg = getOuraConfig(profile.id);
  const connected = conn?.status === "connected" && !!cfg.token;
  // The personal access token was revoked (issue #326) — surface an actionable notice.
  const needsReauth = conn?.status === "needs_reauth";
  const linkedEmail = cfg.personalInfo?.email ?? null;
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

  const events = getIntegrationSyncEvents(profile.id, "oura");
  const lastSuccessAt = getLastSuccessfulSyncAt(profile.id, "oura");

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
          data-testid="oura-error"
        >
          {error}
        </div>
      )}

      {needsReauth && !connected && (
        <div
          className="mb-4 max-w-3xl rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
          data-testid="oura-needs-reauth"
        >
          Your Oura connection expired — the saved personal access token was
          revoked or is no longer valid, so automatic syncing has stopped. Paste
          a fresh token below to resume.
        </div>
      )}

      {connected ? (
        <div className="grid max-w-3xl gap-6">
          <div className="card space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                data-testid="oura-status"
              >
                <IconCheck className="h-3.5 w-3.5" /> Connected
              </span>
              {linkedEmail && (
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {linkedEmail}
                </span>
              )}
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
              <form action={syncOuraAction}>
                <button className="btn">Sync now</button>
              </form>
              <form action={disconnectOuraAction}>
                <button className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950">
                  Disconnect
                </button>
              </form>
            </div>
          </div>

          <SetupCard />

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
              Paste your Oura <strong>personal access token</strong>. Create one
              at{" "}
              <a
                href="https://cloud.ouraring.com/personal-access-tokens"
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 underline dark:text-brand-400"
              >
                cloud.ouraring.com/personal-access-tokens
              </a>
              . We validate it with Oura before saving.
            </p>
            <form action={connectOura} className="grid gap-3">
              <div>
                <label className="label" htmlFor="token">
                  Personal access token
                </label>
                <input
                  id="token"
                  name="token"
                  type="password"
                  className="input"
                  defaultValue=""
                  placeholder="Your Oura personal access token"
                  autoComplete="off"
                  data-testid="oura-token-input"
                />
              </div>
              <div>
                <button className="btn" data-testid="oura-connect">
                  Connect Oura
                </button>
              </div>
            </form>
          </div>

          <SetupCard />
        </div>
      )}
    </div>
  );
}

function SetupCard() {
  return (
    <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Setup
      </h2>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Sign in at{" "}
          <a
            href="https://cloud.ouraring.com/personal-access-tokens"
            target="_blank"
            rel="noreferrer"
            className="text-brand-700 underline dark:text-brand-400"
          >
            cloud.ouraring.com/personal-access-tokens
          </a>{" "}
          and <strong>create a personal access token</strong>. No OAuth app or
          callback URL is needed.
        </li>
        <li>Paste the token here and click Connect Oura.</li>
        <li>
          Sleep, HRV, and workouts then sync automatically every hour, and you
          can press <strong>Sync now</strong> any time.
        </li>
        <li>
          Imported workouts appear under{" "}
          <Link
            href="/training?tab=log"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Training history
          </Link>
          ; sleep, HRV, and resting heart rate feed the{" "}
          <Link
            href="/trends?tab=body"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Body Metrics
          </Link>{" "}
          charts.
        </li>
      </ol>
    </div>
  );
}
