import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection } from "@/lib/integrations/connections";
import { getLastSuccessfulSyncAt } from "@/lib/queries";
import { listPortalIdentities, listPortals } from "@/lib/portals";
import IntegrationSyncHistoryLink from "@/components/IntegrationSyncHistoryLink";
import MyChartSetup from "./MyChartSetup";

export const dynamic = "force-dynamic";

// MyChart (#1739) — the one `external-attended` integration. Allos cannot execute this
// sync: portal sign-in needs a person (two-factor codes, sessions that idle out in
// minutes), so a companion tool runs on the user's own machine and pushes results in
// through the token-authenticated upload API.
//
// The page is therefore setup and status, never a "Sync now" button — offering one would
// promise something allos cannot do. What it owns is the part allos MUST own: the portal
// vocabulary and the patient→profile bindings, because letting the tool decide profile ids
// would put that mapping in local config on every machine, and a stale local mapping
// filing one person's records under another is the harm this whole design prevents.
export default async function MyChartPage() {
  const { login, profile } = await requireSession();
  const def = getIntegration("mychart")!;
  const conn = getConnection(profile.id, "mychart");
  const lastSync = getLastSuccessfulSyncAt(profile.id, "mychart");

  const portals = listPortals();

  // Bindings are shown for the profiles this LOGIN can reach. The stored table is
  // instance-wide (an admin view of "which patient goes where"), so the filtering happens
  // here, at the auth boundary — a member never sees a binding onto a profile they cannot
  // reach, and the write gate re-checks on every action regardless.
  const accessible = await getAccessibleProfiles();
  const accessibleIds = new Set(accessible.map((p) => p.id));
  const identities = listPortalIdentities().filter((i) =>
    accessibleIds.has(i.profileId)
  );

  // The same disambiguated labels the header switcher uses, so "Alex (2)" means the same
  // person here as everywhere else.
  const labels = disambiguateProfileNames(accessible);
  const profiles = accessible.map((p) => ({
    id: p.id,
    name: labels.get(p.id) ?? p.name,
  }));

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
          How it works
        </h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Register each portal below, and map its patients to profiles.</li>
          <li>
            Create an API token under{" "}
            <Link
              href="/settings/tokens"
              className="text-brand-700 hover:underline dark:text-brand-300"
            >
              Settings → API tokens
            </Link>{" "}
            with the <strong>Upload documents</strong> capability. Give each
            computer its own token, so retiring one machine does not disturb the
            others.
          </li>
          <li>
            Run the companion tool on your computer. It signs in the way you
            would — you type the two-factor code — downloads the portal&rsquo;s
            own export, and pushes it here.
          </li>
          <li>
            Documents land in{" "}
            <Link
              href="/data?section=review"
              className="text-brand-700 hover:underline dark:text-brand-300"
            >
              Data → Review
            </Link>
            , same as any other import.
          </li>
        </ol>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          The first run fetches your full history and can take several minutes —
          the portal prepares the export on its own schedule. Later runs only
          pick up what changed.
        </p>
      </div>

      <MyChartSetup
        portals={portals}
        identities={identities}
        profiles={profiles}
        isAdmin={login.role === "admin"}
      />

      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Status
        </h2>
        <p
          data-testid="mychart-status-line"
          className="mt-1 text-sm text-slate-600 dark:text-slate-300"
        >
          {lastSync
            ? `Last checked ${lastSync}.`
            : conn
              ? "Set up, but no run reported yet."
              : "No run reported yet."}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          A run that finds nothing new still counts as a check — the tool
          reports every run, so a quiet week reads as healthy rather than
          broken.
        </p>
        <div className="mt-3">
          <IntegrationSyncHistoryLink
            lastSuccessAt={lastSync}
            connected={conn?.status === "connected"}
            surface="imports"
          />
        </div>
      </div>
    </div>
  );
}
