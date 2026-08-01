import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import {
  accessForProfile,
  requireSession,
  getAccessibleProfiles,
} from "@/lib/auth";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { getIntegration } from "@/lib/integrations/registry";
import { getConnection } from "@/lib/integrations/connections";
import { getLastSuccessfulSyncAt } from "@/lib/queries";
import { anyApiTokenWithScope } from "@/lib/api-tokens";
import {
  identitySyncStatuses,
  listPendingIdentities,
  listPortalIdentities,
} from "@/lib/portals";
import {
  listVisiblePortalRegistry,
  listVisiblePortalRunReports,
} from "@/lib/portal-visibility";
import { portalSetupStage } from "@/lib/portal-setup-stage";
import { portalStatusLine } from "@/lib/portal-status";
import { openSyncRequests } from "@/lib/portal-requests";
import {
  daysUntilExpiry,
  syncRequestCardLine,
  syncRequestCopy,
} from "@/lib/sync-requests";
import { today } from "@/lib/db";
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
//
// ── A GUIDED FLOW, NOT A WALL OF CARDS (#1826) ───────────────────────────────
//
// Everything above was true and the page still rendered all of it at once: eight flat
// sibling cards in an order that did not match the numbered steps it advertised. This
// page now DERIVES the setup stage (lib/portal-setup-stage.ts, pure, unit-tested) and
// renders only that stage's card with one next step. Maintenance — the registry, the
// add forms, unbind, and the manual bind demoted to an explicit escape hatch — lives in
// a collapsed "Manage portals & logins" section that any stage can open. Progressive
// disclosure, not lockout.
//
// THE REGISTRY READ IS THE SCOPED ONE (#1796). This page used to read `listPortals()` /
// `listPortalAccounts()` — the whole instance-wide vocabulary — and only the ADMIN card
// was gated, which left a non-admin's sync-request rows naming every household's portals
// and login nicknames. `listVisiblePortalRegistry` is the same predicate #1791/#1796
// already ruled for the API twin, so the page narrows onto it. For an admin the two are
// identical (an admin reaches every profile), so nothing an admin sees changes; for
// everyone else this only ever removes rows. It is also what makes the derived stage
// honest per viewer: an empty registry means "nothing here is yours", and the card that
// renders for it names no portal.
export default async function PatientPortalsPage() {
  const { login, profile } = await requireSession();
  const def = getIntegration("patient-portals")!;
  const conn = getConnection(profile.id, "patient-portals");
  const lastSync = getLastSuccessfulSyncAt(profile.id, "patient-portals");

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

  // The portal vocabulary this viewer may see (#1796), and the same `canSeeUnclaimed`
  // population the pending list takes — one gate decides it for every surface.
  const { portals, accounts } = listVisiblePortalRegistry(
    [...accessibleIds],
    canManagePending
  );

  // OPEN sync requests (#1757), one per portal login at most. Formatted here through the
  // SAME pure formatter the Upcoming item and the digest line use, so the card and the
  // nudge describe one state. Read for the population that can act on it — the same gate
  // the pending list takes — since the button that raises one is gated that way too.
  const cardToday = today(profile.id);
  const visibleAccountIds = new Set(accounts.map((a) => a.id));
  const syncRequests = canManagePending
    ? openSyncRequests()
        .filter((r) => visibleAccountIds.has(r.accountId))
        .map((r) => ({
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

  // Run reports are ACCOUNT-level and carry no profile_id — that is what puts a run
  // there — so the account's reachability is what decides visibility (#1787): an account
  // bound to a profile in `accessibleIds`, or (for the same population that sees
  // `pending`) one bound to nobody yet. Scoped in the READ, not filtered here; a surface
  // that filters what it was handed is one refactor away from leaking again, and the
  // failure `message` is 500 characters of free text from an external tool.
  const reports = listVisiblePortalRunReports(
    [...accessibleIds],
    canManagePending
  );

  // The Status sentence (#1756). ONE pure function decides it, because the card used to
  // answer "has anything happened?" two ways at once: "No run reported yet." above a list
  // of patients a run had just reported. The account-level run reports are what make the
  // first-contact and portal-level-failure cases visible at all — a run with no bound
  // patient has no profile, so no profile-scoped sync event exists to read.
  const statusLine = portalStatusLine({
    lastSuccessAt: lastSync,
    connected: conn !== undefined,
    reports,
    // The same list the card renders, so the sentence never points at a card the viewer
    // cannot see.
    pending,
  });

  // WHERE THIS HOUSEHOLD IS (#1826). Every fact is the VIEWER's — the scoped registry,
  // the scoped reports, the gated pending list — so the next step the page names is one
  // its reader could actually take. The token fact is the single instance-wide input,
  // and it is a bare boolean; see lib/api-tokens.ts for why it is not per-login.
  const stage = portalSetupStage({
    portalCount: portals.length,
    hasUploadToken: anyApiTokenWithScope("upload:documents"),
    reportCount: reports.length,
    pendingCount: pending.length,
  });

  return (
    // "flow" — a guided multi-step flow, which is now literally what this page is. The
    // old uncapped stack ran setup prose to the full width of a desktop shell.
    <PageContainer width="flow" className="space-y-6">
      <div>
        <Link
          href="/data?section=import"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
        >
          <IconArrowLeft className="h-4 w-4" /> Import
        </Link>
        <PageHeader title={def.name} />
      </div>

      {/* The five-step overview survives as a COLLAPSIBLE, not a permanent card (#1826).
          Each stage below states its own next step in a sentence or two; this is here for
          the person who wants the whole shape before they start, and for the one who
          wants to check what comes after where they are. */}
      <details
        className="card text-sm text-slate-600 dark:text-slate-300"
        data-testid="portals-how-it-works"
      >
        <summary
          className="cursor-pointer font-medium text-slate-800 dark:text-slate-100"
          data-testid="portals-how-it-works-toggle"
        >
          How this works, all five steps
        </summary>
        <p className="mt-3">{def.blurb}</p>
        <ol className="mt-3 list-decimal space-y-1 pl-5">
          <li>Add the portal you use, by name.</li>
          <li>
            Create an API token with the <strong>Upload documents</strong>{" "}
            capability under{" "}
            <Link
              href="/settings/tokens"
              className="text-brand-700 hover:underline dark:text-brand-300"
              data-testid="how-it-works-token-link"
            >
              Settings → API tokens
            </Link>
            .
          </li>
          <li>
            Run the companion tool on your computer. You type the two-factor
            code; it reports which patients that login covers.
          </li>
          <li>Map each reported patient to a profile, once.</li>
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
      </details>

      <PortalSetup
        stage={stage}
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
        statusLine={statusLine}
        lastSuccessAt={lastSync}
      />
    </PageContainer>
  );
}
