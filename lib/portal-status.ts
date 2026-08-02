// The PURE per-login run status of the Patient portals page. No DB, no request — the
// page reads the rows, this decides each login row's sentence, and a unit test pins
// every branch.
//
// ── FROM ONE PAGE-BOTTOM SENTENCE TO ONE LINE PER LOGIN (#1874) ──────────────
//
// #1756 built `portalStatusLine`: ONE status sentence for the whole page, derived from
// the globally-newest run report plus the ACTIVE profile's last successful sync. It
// fixed the first-contact lie ("No run reported yet." above a list of patients a run
// had just reported), but the page walk behind #1874 showed its two remaining costs:
// the sentence sat at the page bottom, far from the login it described, and its
// profile-scoped half meant switching the header profile silently rewrote the page's
// claim — scope confusion on a household-wide surface.
//
// #1874 retires the page-level sentence. A run belongs to a LOGIN — that is the whole
// argument of the account-level run reports (#1756) — so its status now renders on the
// login's own row, and this module formats exactly that: one login's last reported run.
// First contact needs no special sentence anymore, because the pending rows themselves
// are permanent structure directly under the login that reported them. Per-patient
// "Last checked" stays on the patient rows (identitySyncStatuses), which was always the
// finer-grained half of the answer.
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
// claim it. It surfaces HERE instead, as an attention-toned line on the login that owns
// the run. Do not "fix" this by attributing such a run to a guessed profile; guessing
// which person a portal run belongs to is the harm this whole surface exists to prevent.

export type PortalStatusTone = "ok" | "attention" | "idle";

export interface PortalLoginStatus {
  tone: PortalStatusTone;
  text: string;
}

// The slice of an account-level run report this needs — structural, so the pure module
// never imports the DB layer that produces it.
export interface PortalRunLike {
  at: string;
  ok: boolean;
  // The tool's own failure line, or null. Free text from an authenticated but untrusted
  // tool — render as text, never as markup.
  message: string | null;
}

function day(stamp: string): string {
  return stamp.slice(0, 10);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// One login's last reported run, as its row states it. `null` means the login has never
// reported at all — honest idle, not failure: this integration is attended, so a quiet
// login is a login nobody has run yet, not a broken one.
export function portalLoginStatus(
  report: PortalRunLike | null
): PortalLoginStatus {
  if (!report) {
    return { tone: "idle", text: "No run reported yet." };
  }
  if (!report.ok) {
    return {
      tone: "attention",
      text: report.message
        ? sentence(`Last run failed ${day(report.at)}: ${report.message}`)
        : `Last run failed ${day(report.at)}.`,
    };
  }
  // A run that found nothing new still counts as a check — that is the point of the
  // every-run report: a quiet week reads as healthy rather than broken.
  return { tone: "ok", text: `Last run ${day(report.at)}` };
}
