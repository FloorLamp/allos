// The PURE Status line of the Patient portals card (issue #1756). No DB, no request —
// the page reads the rows, this decides the sentence, and a unit test pins every branch.
//
// ── WHAT WENT WRONG, AND WHY IT IS ONE FUNCTION ──────────────────────────────
//
// The card promises, in its own words, that "the tool reports every run, so a quiet week
// reads as healthy rather than broken". The FIRST run then violated it: that run's own
// patient is not bound yet, so its report is refused, no profile-scoped sync event lands,
// and the Status line said "No run reported yet." — at the exact moment a household is
// deciding whether to trust this thing. The pending rows below it said otherwise. Two
// surfaces answering one question differently is the bug, so there is now one function
// that answers it, and both the sentence and its tone come out of here.
//
// ── THE FAILURE-BADGE ASYMMETRY (deliberate, and easy to misread) ────────────
//
// A `failed` report that names a MAPPED patient still drives Data → Review's failure
// badge, exactly as before — it has a profile, so it lands as an ordinary sync event and
// every profile-scoped reader sees it.
//
// A PORTAL-LEVEL failure cannot, and this is not an oversight to be fixed later. That
// badge is `getImportIssues(profileId)`: profile-scoped by construction, like every other
// reader of integration_sync_events. A pre-patient portal failure genuinely has no
// profile — that is what makes it portal-level — so no profile's Review can honestly
// claim it. It surfaces HERE instead, as an attention-toned line on the card that owns
// the portal. Do not "fix" this by attributing such a run to a guessed profile; guessing
// which person a portal run belongs to is the harm this whole surface exists to prevent.

export type PortalStatusTone = "ok" | "attention" | "idle";

export interface PortalStatusLine {
  tone: PortalStatusTone;
  text: string;
}

// The account-level run report shape this needs — structural, so the pure module never
// imports the DB layer that produces it.
export interface PortalRunReportLike {
  portalName: string;
  accountName: string;
  accountImplicit: boolean;
  at: string;
  ok: boolean;
  message: string | null;
  discovered: number;
}

export interface PortalStatusInput {
  // Last SUCCESSFUL sync event for the active profile, or null. Profile-scoped, which is
  // why it cannot answer the first-contact question on its own.
  lastSuccessAt: string | null;
  // Whether the integration has a connection row for the active profile.
  connected: boolean;
  // Every login's last reported run. Account-level, so it survives a run with no profile.
  reports: PortalRunReportLike[];
  // Identities still waiting to be mapped, as shown on the card. Empty for a viewer who
  // cannot act on them, so this never points someone at a card they cannot see.
  pending: { portalName: string }[];
}

function day(stamp: string): string {
  return stamp.slice(0, 10);
}

// "Ochsner MyChart", or "Ochsner MyChart (Mom)" once the login is worth naming. Same rule
// the rest of the card uses: an implicit login is an implementation detail of the key.
function label(report: PortalRunReportLike): string {
  return report.accountImplicit
    ? report.portalName
    : `${report.portalName} (${report.accountName})`;
}

// Distinct, in first-seen order — a household with two portals waiting hears both named.
function portalNames(rows: { portalName: string }[]): string {
  const seen: string[] = [];
  for (const r of rows)
    if (!seen.includes(r.portalName)) seen.push(r.portalName);
  return seen.join(", ");
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function portalStatusLine(input: PortalStatusInput): PortalStatusLine {
  const newest = input.reports.reduce<PortalRunReportLike | null>(
    (best, r) => (best === null || r.at > best.at ? r : best),
    null
  );

  // 1. A failure the household has not already recovered from. A later SUCCESS on this
  //    profile supersedes it — the point of "last checked" is how long it has really been
  //    since the portal was read, and a recovered run answers that.
  if (
    newest &&
    !newest.ok &&
    (input.lastSuccessAt === null || input.lastSuccessAt < newest.at)
  ) {
    return {
      tone: "attention",
      text: newest.message
        ? sentence(`The last run on ${label(newest)} failed: ${newest.message}`)
        : `The last run on ${label(newest)} failed.`,
    };
  }

  // 2. FIRST CONTACT: a run happened, it taught allos who is on the portal, and nothing
  //    has ever been checked for this profile. This is the dead zone — the run was
  //    refused, so no sync event exists — and the honest sentence is the next ACTION, not
  //    "no run reported yet".
  if (input.lastSuccessAt === null && input.pending.length > 0) {
    const n = input.pending.length;
    return {
      tone: "attention",
      text:
        `The tool reported ${n} ${n === 1 ? "patient" : "patients"} on ` +
        `${portalNames(input.pending)} — map ${n === 1 ? "that patient" : "them"} ` +
        `below to finish setup.`,
    };
  }

  // 3. The ordinary healthy answer.
  if (input.lastSuccessAt) {
    return { tone: "ok", text: `Last checked ${input.lastSuccessAt}.` };
  }

  // 4. A run was reported, but not one that counts as a check for THIS profile — it
  //    belonged to another profile's patient, or everything on that login is ignored.
  //    Saying "no run reported yet" here would repeat the original lie in miniature.
  if (newest) {
    return {
      tone: "idle",
      text: `The tool reported a run on ${label(newest)} on ${day(
        newest.at
      )}, but nothing has been checked for this profile yet.`,
    };
  }

  return {
    tone: "idle",
    text: input.connected
      ? "Set up, but no run reported yet."
      : "No run reported yet.",
  };
}
