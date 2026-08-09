import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection } from "@/lib/integrations/connections";
import { deliveryForKind } from "@/lib/integrations/delivery";
import { silenceToleranceMinutes } from "@/lib/integrations/staleness";
import {
  escalationPolicyLabel,
  syncRunNounForKind,
} from "@/lib/integrations/provider-state";
import { getLastSuccessfulSyncAt } from "@/lib/queries";
import IntegrationSyncHistoryLink from "@/components/IntegrationSyncHistoryLink";
import TakeoutUpload from "./TakeoutUpload";

export const dynamic = "force-dynamic";

// Fitbit via Google Takeout — the one `archive` integration. There is nothing to
// connect and nothing to reconnect: the user downloads an export from Google and
// hands it over, so this page is instructions plus a file picker plus whatever the
// last import did. Re-importing is safe and expected (every write dedups on its
// natural key), which is why the copy invites it rather than warning against it.
export default async function FitbitTakeoutPage() {
  const { profile } = await requireSession();
  const def = getIntegration("fitbit-takeout")!;
  const conn = getConnection(profile.id, "fitbit-takeout");
  const lastImport = getLastSuccessfulSyncAt(profile.id, "fitbit-takeout");
  // The escalation policy, stated where the reader is (#1880 item 1, #2301). Every
  // scheduled provider page states its own rule under the sync history; this page has
  // no history table, so the one thing an attended source's owner needs to know — that
  // allos will never mark it late, because only they can start it — had no surface at
  // all. Sourced exactly as `SyncHistoryTable` sources it, and DERIVED FROM THE KIND
  // rather than asserting "attended" here: the kind is where delivery is declared, so
  // this line cannot drift from it.
  const policy = escalationPolicyLabel(
    silenceToleranceMinutes(def),
    syncRunNounForKind(def.kind),
    deliveryForKind(def.kind)
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/data?section=import"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
        >
          <IconArrowLeft className="h-4 w-4" /> Import
        </Link>
        <PageHeader title={def.name} />
      </div>

      <div className="card">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {def.blurb}
        </p>
      </div>

      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Get your export
        </h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>
            Go to{" "}
            <a
              href="https://takeout.google.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 hover:underline dark:text-brand-300"
            >
              Google Takeout
            </a>{" "}
            signed in as the account your Fitbit is linked to.
          </li>
          <li>
            Deselect everything, then select only <strong>Fitbit</strong> (it
            may be listed as <strong>Google Health</strong>).
          </li>
          <li>
            Export as a <strong>.zip</strong>. Google emails a download link
            when it is ready — that can take minutes or hours.
          </li>
          <li>Download the zip and upload it below.</li>
        </ol>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          If Google split your export into several parts, upload each one — they
          import independently and overlapping data is recognized, not
          duplicated.
        </p>
      </div>

      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Import an archive
        </h2>
        <p className="mt-1 mb-3 text-sm text-slate-500 dark:text-slate-400">
          The file is read on the server and deleted straight after — only the
          health records it contains are kept.
        </p>
        <TakeoutUpload />
      </div>

      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          What comes in
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {def.dataTypes.map((t) => (
            <span
              key={t}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 dark:bg-ink-800 dark:text-slate-300"
            >
              {t}
            </span>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Fitbit&rsquo;s sleep and readiness scores are stored as{" "}
          <em>Fitbit&rsquo;s</em> numbers — shown attributed, and never used to
          compute anything else here.
        </p>
      </div>

      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Status
        </h2>
        <p
          data-testid="takeout-status"
          className="mt-1 text-sm text-slate-600 dark:text-slate-300"
        >
          {lastImport
            ? `Last import ${lastImport}.`
            : conn
              ? "Set up, but nothing imported yet."
              : "No archive imported yet."}
        </p>
        {policy && (
          <p
            data-testid="takeout-escalation-policy"
            className="mt-3 max-w-prose rounded-lg border border-dashed border-black/10 px-3 py-2 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400"
          >
            {policy}
          </p>
        )}
        <div className="mt-3">
          <IntegrationSyncHistoryLink lastSuccessAt={lastImport} />
        </div>
      </div>
    </div>
  );
}
