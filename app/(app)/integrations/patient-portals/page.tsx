import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import {
  accessForProfile,
  requireSession,
  getAccessibleProfiles,
} from "@/lib/auth";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection } from "@/lib/integrations/connections";
import { getLastSuccessfulSyncAt } from "@/lib/queries";
import {
  identitySyncStatuses,
  listPendingIdentities,
  listPortalAccounts,
  listPortalIdentities,
  listPortalRunReports,
  listPortals,
} from "@/lib/portals";
import { portalStatusLine } from "@/lib/portal-status";
import { openSyncRequests } from "@/lib/portal-requests";
import {
  daysUntilExpiry,
  syncRequestCardLine,
  syncRequestCopy,
} from "@/lib/sync-requests";
import { today } from "@/lib/db";
import IntegrationSyncHistoryLink from "@/components/IntegrationSyncHistoryLink";
import PortalSetup from "./PortalSetup";

export const dynamic = "force-dynamic";

// Patient portals (#1739) — the one `external-attended` integration. Allos cannot execute
// this sync: portal sign-in needs a person (two-factor codes, sessions that idle out in
// minutes), so a companion tool runs on the user's own machine and pushes results in
// through the token-authenticated upload API.
//
// The integration is named for the DOCUMENT FAMILY, not for one vendor's tool: the
// CCD/C-CDA export is a regulatory requirement, so every major portal emits it. MyChart is
// the first tool that implements the contract.
//
// The page is therefore setup and status, never a "Sync now" button — offering one would
// promise something allos cannot do. What it owns is the part allos MUST own: the portal
// and login vocabulary, and the patient→profile bindings, because letting the tool decide
// profile ids would put that mapping in local config on every machine, and a stale local
// mapping filing one person's records under another is the harm this whole design
// prevents.
export default async function PatientPortalsPage() {
  const { login, profile } = await requireSession();
  const def = getIntegration("patient-portals")!;
  const conn = getConnection(profile.id, "patient-portals");
  const lastSync = getLastSuccessfulSyncAt(profile.id, "patient-portals");

  const portals = listPortals();
  const accounts = listPortalAccounts();

  // Bindings are shown for the profiles this LOGIN can reach. The stored table is
  // instance-wide (an admin view of "which patient goes where"), so the filtering happens
  // here, at the auth boundary — a member never sees a binding onto a profile they cannot
  // reach, and the write gate re-checks on every action regardless. IGNORED bindings name
  // no profile at all, so there is nothing to filter them by; they are household-level
  // "do not sync this person" statements and are shown to everyone who can see the card.
  const accessible = await getAccessibleProfiles();
  const accessibleIds = new Set(accessible.map((p) => p.id));
  const identities = listPortalIdentities().filter(
    (i) => i.ignored || (i.profileId !== null && accessibleIds.has(i.profileId))
  );

  // The same disambiguated labels the header switcher uses, so "Alex (2)" means the same
  // person here as everywhere else.
  const labels = disambiguateProfileNames(accessible);
  const profiles = accessible.map((p) => ({
    id: p.id,
    name: labels.get(p.id) ?? p.name,
  }));
  // Pickers offer only what this login may WRITE: binding onto a read-only profile is
  // refused at the gate, so offering it would be an invitation to a guaranteed error.
  const writableProfiles = profiles.filter(
    (p) => accessForProfile(login.id, login.role, p.id) === "write"
  );

  // Identities the acquirer reported that allos could not place. Read for any login that
  // could actually ACT on them — write access to at least one profile, the same population
  // the picker serves — and for admins. A pending row has no profile, so unlike a binding
  // there is no accessible set to filter it through; showing portal-spelled patient labels
  // to caregiver-members with write access is a deliberate, owner-approved trade so a
  // caregiver can finish their own portal setup without an admin.
  const canManagePending =
    login.role === "admin" || writableProfiles.length > 0;
  const pending = canManagePending ? listPendingIdentities() : [];

  // OPEN sync requests (#1757), one per portal login at most. Formatted here through the
  // SAME pure formatter the Upcoming item and the digest line use, so the card and the
  // nudge describe one state. Read for the population that can act on it — the same gate
  // the pending list takes — since the button that raises one is gated that way too.
  const cardToday = today(profile.id);
  const syncRequests = canManagePending
    ? openSyncRequests().map((r) => ({
        accountId: r.accountId,
        line: syncRequestCardLine(
          syncRequestCopy({
            portalName: r.portalName,
            accountName: r.accountName,
            accountImplicit: r.accountImplicit,
            reason: r.reason,
          }),
          daysUntilExpiry(r.expiresAt, cardToday)
        ),
      }))
    : [];

  // Per-(login, patient) "Last synced" for the ACTIVE profile's runs.
  const statuses = identitySyncStatuses(profile.id, "patient-portals");

  // The Status sentence (#1756). ONE pure function decides it, because the card used to
  // answer "has anything happened?" two ways at once: "No run reported yet." above a list
  // of patients a run had just reported. The account-level run reports are what make the
  // first-contact and portal-level-failure cases visible at all — a run with no bound
  // patient has no profile, so no profile-scoped sync event exists to read.
  const statusLine = portalStatusLine({
    lastSuccessAt: lastSync,
    connected: conn !== undefined,
    reports: listPortalRunReports(),
    // The same list the card renders, so the sentence never points at a card the viewer
    // cannot see.
    pending,
  });

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
          <li>
            Register each portal below. If two people sign in to the same portal
            with their own accounts, give each login a nickname.
          </li>
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
            would — you type the two-factor code — and reports which patients
            that login covers.
          </li>
          <li>
            Those patients appear here to be mapped to profiles. Map them once;
            later runs land automatically.
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

      <PortalSetup
        portals={portals}
        accounts={accounts}
        identities={identities}
        pending={pending}
        statuses={statuses}
        syncRequests={syncRequests}
        profiles={profiles}
        writableProfiles={writableProfiles}
        isAdmin={login.role === "admin"}
        canManagePending={canManagePending}
      />

      <div className="card">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Status
        </h2>
        <p
          data-testid="portals-status-line"
          data-tone={statusLine.tone}
          className={
            statusLine.tone === "attention"
              ? "mt-1 text-sm text-amber-700 dark:text-amber-300"
              : "mt-1 text-sm text-slate-600 dark:text-slate-300"
          }
        >
          {statusLine.text}
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
