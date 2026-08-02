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
import { anyApiTokenWithScope } from "@/lib/api-tokens";
import {
  identitySyncStatuses,
  listPortalIdentities,
  type IdentitySyncStatus,
} from "@/lib/portals";
import {
  listVisiblePendingIdentities,
  listVisiblePortalRegistry,
  listVisiblePortalRunReports,
} from "@/lib/portal-visibility";
import { portalChecklist, portalSetupStage } from "@/lib/portal-setup-stage";
import { portalLoginStatus } from "@/lib/portal-status";
import { openSyncRequests } from "@/lib/portal-requests";
import {
  daysUntilExpiry,
  syncRequestCardLine,
  syncRequestCopy,
} from "@/lib/sync-requests";
import { today } from "@/lib/db";
import PortalsSurface, {
  type AccountView,
  type IdentityView,
  type PendingView,
  type PortalView,
  type ProfileChoice,
} from "./PortalsSurface";

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
// ── THE OBJECT MODEL IS THE PAGE (#1874) ─────────────────────────────────────
//
// #1826 made setup guided — one stage card at a time — but the guidance REPLACED the
// structure: creating a portal produced no visible object, and portals/logins/mappings
// surfaced only as fragments across a stage card, a collapsed Manage drawer, and a
// bottom status sentence. This page now renders the hierarchy itself, always:
//
//   portal → login → patient
//
// Each portal is a permanent card-section from creation. Logins render as titled
// sub-groups inside their portal only when there are two or more (a one-login portal IS
// its login; the implicit "Default login" concept never surfaces). Patients live under
// their login as avatar-chip rows. The stage machine survives as a CHECKLIST
// (lib/portal-setup-stage.ts) rendered above the sections until steady state; on first
// visit it unrolls into the five-step guide whose step 1 IS the add-portal form. The
// Manage drawer, the separate "Mapped patients" list, and the page-bottom status line
// are gone — feedback renders inline on the acted-on row, and each login row carries its
// own last-run status (lib/portal-status.ts).
//
// ── SCOPE, STATED ONCE (#1874/#1875) ─────────────────────────────────────────
//
// The page is household-wide and says so once; nothing on it follows the active profile
// (the old status sentence did, so switching the header profile silently rewrote the
// page's claim). Per-patient "Last checked" lives on the patient rows, each computed
// against the profile that patient is actually bound to.
//
// Every read is the VIEWER's (#1796/#1875): the registry, the run reports, and the
// pending list all narrow onto accounts claimed by a profile this login can access.
// UNCLAIMED (first-contact) accounts are ADMIN-ONLY on this page — #1875's ruling: a
// first-contact portal has no mappings yet, and "an admin adds portals" owns that era.
// (The token-authenticated registry endpoint keeps its own wider rule; see
// lib/portal-visibility.ts.) A member therefore sees exactly the logins that cover
// profiles they can reach, with a scope note saying so.
export default async function PatientPortalsPage() {
  const { login, profile } = await requireSession();
  const def = getIntegration("patient-portals")!;
  const isAdmin = login.role === "admin";

  const accessible = await getAccessibleProfiles();
  const accessibleIds = [...accessible.map((p) => p.id)];
  const accessibleSet = new Set(accessibleIds);

  // Bindings are shown for the profiles this LOGIN can reach. The stored table is
  // instance-wide (an admin view of "which patient goes where"), so the filtering happens
  // here, at the auth boundary — a member never sees a binding onto a profile they cannot
  // reach, and the write gate re-checks on every action regardless. IGNORED bindings name
  // no profile at all; they render under their account, so account visibility (below)
  // decides who meets them.
  const identities = listPortalIdentities().filter(
    (i) => i.ignored || (i.profileId !== null && accessibleSet.has(i.profileId))
  );

  // The same disambiguated labels the header switcher uses, so "Alex (2)" means the same
  // person here as everywhere else. Avatar fields ride along — the chips ARE the picker.
  const labels = disambiguateProfileNames(accessible);
  const profiles: ProfileChoice[] = accessible.map((p) => ({
    id: p.id,
    name: labels.get(p.id) ?? p.name,
    photoPath: p.photo_path,
    photoVersion: p.photo_version,
  }));
  // Chip pickers offer only what this login may WRITE: binding onto a read-only profile
  // is refused at the gate, so offering it would be an invitation to a guaranteed error.
  const writableProfiles = profiles.filter(
    (p) => accessForProfile(login.id, login.role, p.id) === "write"
  );

  // The portal vocabulary this viewer may see. Unclaimed accounts are admin-only on this
  // page (#1875) — a member sees only logins already covering a profile they can reach.
  const { portals, accounts } = listVisiblePortalRegistry(
    accessibleIds,
    isAdmin
  );

  // Pendings through the SCOPED read (#1875) — never the instance-wide list filtered
  // here. Same predicate, same admin-only unclaimed clause as the registry above.
  const pending = listVisiblePendingIdentities(accessibleIds, isAdmin);

  // Run reports are ACCOUNT-level and carry no profile_id — that is what puts a run
  // there — so the account's reachability decides visibility (#1787), with the same
  // admin-only unclaimed clause as everything else on this page.
  const reports = listVisiblePortalRunReports(accessibleIds, isAdmin);
  const reportByAccount = new Map(reports.map((r) => [r.accountId, r]));

  // Sync requests may be raised by the same population that can act on the page at all.
  const canAct = isAdmin || writableProfiles.length > 0;
  // The expiry countdown reads the SESSION's day — a formatting context for "expires in
  // N days", not a scope claim about whose data the page shows.
  const cardToday = today(profile.id);
  const visibleAccountIds = new Set(accounts.map((a) => a.id));
  const requestLines = new Map<number, string>();
  if (canAct) {
    for (const r of openSyncRequests()) {
      if (!visibleAccountIds.has(r.accountId)) continue;
      requestLines.set(
        r.accountId,
        syncRequestCardLine(
          syncRequestCopy({
            portalName: r.portalName,
            accountName: r.accountName,
            accountImplicit: r.accountImplicit,
            reason: r.reason,
          }),
          daysUntilExpiry(r.expiresAt, cardToday)
        )
      );
    }
  }

  // Per-(login, patient) "Last checked", computed against the profile each patient is
  // BOUND to — never the active profile. A household with two portals and three patients
  // has six answers to "when was this last checked", and each belongs to its own row.
  const mappedProfileIds = [
    ...new Set(
      identities
        .filter((i) => !i.ignored && i.profileId !== null)
        .map((i) => i.profileId as number)
    ),
  ];
  const statusByProfile = new Map<number, IdentitySyncStatus[]>(
    mappedProfileIds.map((pid) => [
      pid,
      identitySyncStatuses(pid, "patient-portals"),
    ])
  );
  const statusFor = (i: {
    accountId: number;
    patientLabel: string;
    profileId: number | null;
  }): IdentitySyncStatus | null => {
    if (i.profileId === null) return null;
    return (
      statusByProfile
        .get(i.profileId)
        ?.find(
          (s) =>
            s.accountId === i.accountId && s.patientLabel === i.patientLabel
        ) ?? null
    );
  };

  const identityViews: IdentityView[] = identities.map((i) => {
    const st = statusFor(i);
    return {
      id: i.id,
      accountId: i.accountId,
      patientLabel: i.patientLabel,
      profileId: i.profileId,
      ignored: i.ignored,
      declined: i.declined,
      lastOkAt: st?.lastOkAt ?? null,
      lastFailedAt: st?.lastFailedAt ?? null,
    };
  });

  // The cross-login "same person" assist (#1874 point 6): a pending label EXACTLY
  // matching an identity already mapped on another login (any portal) suggests that
  // mapping's profile — suggest-only, never auto-applied, and only when the viewer could
  // actually write the suggested profile. This is what turns "the same child listed
  // twice via two logins" from an apparent duplicate bug into a one-tap answer.
  const mappedForAssist = identities.filter(
    (i) => !i.ignored && i.profileId !== null
  );
  const pendingViews: PendingView[] = pending.map((p) => {
    const twin = mappedForAssist.find(
      (i) => i.patientLabel === p.patientLabel && i.accountId !== p.accountId
    );
    const suggestion =
      twin && writableProfiles.some((w) => w.id === twin.profileId)
        ? {
            profileId: twin.profileId as number,
            where: twin.accountImplicit ? twin.portalName : twin.accountName,
          }
        : null;
    return {
      id: p.id,
      accountId: p.accountId,
      patientLabel: p.patientLabel,
      firstSeenAt: p.firstSeenAt,
      lastSeenAt: p.lastSeenAt,
      seenCount: p.seenCount,
      suggestion,
    };
  });

  const accountViews: AccountView[] = accounts.map((a) => {
    const report = reportByAccount.get(a.id) ?? null;
    return {
      id: a.id,
      portalId: a.portalId,
      name: a.name,
      implicit: a.implicit,
      hasReport: report !== null,
      status: portalLoginStatus(report),
      openRequestLine: requestLines.get(a.id) ?? null,
    };
  });

  const portalViews: PortalView[] = portals.map((p) => ({
    id: p.id,
    name: p.name,
    software: p.software,
  }));

  // WHERE THIS HOUSEHOLD IS. Every fact is the VIEWER's — the scoped registry, the
  // scoped reports, the scoped pending list — so every step the checklist names is one
  // its reader could actually take. The token fact is the single instance-wide input,
  // and it is a bare boolean; see lib/api-tokens.ts for why it is not per-login.
  const facts = {
    portalCount: portalViews.length,
    hasUploadToken: anyApiTokenWithScope("upload:documents"),
    reportCount: reports.length,
    pendingCount: pendingViews.length,
  };
  const stage = portalSetupStage(facts);
  const checklist = portalChecklist(facts);

  return (
    // "flow" — a guided multi-step flow. The old uncapped stack ran setup prose to the
    // full width of a desktop shell.
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

      <PortalsSurface
        stage={stage}
        checklist={checklist}
        blurb={def.blurb}
        portals={portalViews}
        accounts={accountViews}
        identities={identityViews}
        pending={pendingViews}
        profiles={profiles}
        writableProfiles={writableProfiles}
        isAdmin={isAdmin}
        canAct={canAct}
      />
    </PageContainer>
  );
}
