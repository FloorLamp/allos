import Link from "next/link";
import { PageHeader } from "@/components/ui";
import LeadFold from "@/components/LeadFold";
import PageContainer from "@/components/PageContainer";
import { Notice } from "@/components/Notice";
import { getIntegration } from "@/lib/integrations/registry";
import {
  getConnection,
  getWithingsConfig,
} from "@/lib/integrations/connections";
import { getIntegrationState, SETUP_HISTORY_LIMIT } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import IntegrationStatusHeader from "@/components/integrations/IntegrationStatusHeader";
import IntegrationDisconnectButton from "@/components/integrations/IntegrationDisconnectButton";
import SyncHistoryTable from "@/components/integrations/SyncHistoryTable";
import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import { TokenRow } from "@/components/TokenRow";
import { withingsCallbackUrl } from "./url";
import BackLink from "@/components/BackLink";
import {
  saveWithingsCredentials,
  connectWithings,
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
  set_public_url:
    "This app's callback URL resolves to localhost, so Withings can't redirect back. Set the Public app URL in Settings → Server to the address this app is reachable at, then reconnect.",
};

export default async function WithingsPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { login, profile } = await requireSession();
  const def = getIntegration("withings")!;
  const conn = getConnection(profile.id, "withings");
  const cfg = getWithingsConfig(profile.id);
  const hasCreds = !!(cfg.clientId && cfg.clientSecret);
  const connected = conn?.status === "connected" && !!cfg.accessToken;
  // The refresh token died/was revoked (issue #326) — surface an actionable notice.
  const needsReauth = conn?.status === "needs_reauth";
  const callbackUrl = await withingsCallbackUrl();
  const error = searchParams.error
    ? (ERROR_MESSAGES[searchParams.error] ?? "Couldn't connect. Try again.")
    : null;

  // THE per-source state (#1772): one computation behind this page, Review's
  // inbox, and the Integrations grid.
  const state = getIntegrationState(
    profile.id,
    "withings",
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

      {error && (
        <Notice tone="rose" testid="withings-error" className="mb-4 max-w-3xl">
          {error}
        </Notice>
      )}

      {needsReauth && !connected && (
        <Notice
          tone="rose"
          testid="withings-needs-reauth"
          className="mb-4 max-w-3xl"
        >
          Your Withings connection expired — the saved token was revoked or is
          no longer valid, so automatic syncing has stopped. Reconnect with
          Withings below to resume.
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
                  <IntegrationActionButton kind="sync" sourceId="withings" />
                  <IntegrationDisconnectButton
                    kind="disconnect"
                    serverAction={disconnectWithingsAction}
                  />
                </>
              }
            />
          </div>

          <SetupCard callbackUrl={callbackUrl} />

          <SyncHistoryTable state={state} isAdmin={login.role === "admin"} />
        </div>
      ) : (
        <div className="grid gap-6">
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
              <code className="break-all rounded-sm bg-slate-100 px-1 py-0.5 text-xs dark:bg-ink-800">
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
    </PageContainer>
  );
}

function SetupCard({ callbackUrl }: { callbackUrl: string }) {
  return (
    <div className="card space-y-3 text-sm text-slate-600 dark:text-slate-300">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Setup
      </h2>
      <TokenRow label="Callback URI" value={callbackUrl} />
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
            href="/trends#body"
            className="text-brand-700 underline dark:text-brand-400"
          >
            Body metrics
          </Link>{" "}
          charts; blood pressure, SpO₂, and temperature land as{" "}
          <Link
            href="/trends#body"
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
