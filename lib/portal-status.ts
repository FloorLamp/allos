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
// The per-patient chips stay on the patient rows (identitySyncStatuses), which was
// always the finer-grained half of the answer; #2914 renamed them "Last synced".
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
//
// ── A DELIVERY IS NOT A CHECK, AND THE ROW NOW SAYS SO (#2914) ───────────────
//
// #1888 gave delivery-only reports (`contacted: false`) their back-end semantics: they
// record events and documents but answer no sync request and move no staleness clock.
// Its review warned the read side not to "over-rotate and make pushes look like nothing
// happened" — and that is exactly what shipped here. Every ok report rendered the same
// `Last run <day>`, so a push that delivered eight archives was indistinguishable from
// an empty check, and from the line already on screen from an earlier run the same day.
//
// So the sentence now names the RUN KIND and the DELIVERED COUNT, and — when the
// login's real check clock lags the delivery — states that clock too. A household that
// sees "Delivered 4 documents 2026-08-15 · portal last checked 2026-08-10" beside a
// standing sync request is looking at a page that agrees with itself, instead of one
// raising a staleness ask minutes after documents demonstrably arrived.
//
// COUNTS ARE DOCUMENTS, never extracted records (#2914's owner decision): this page's
// vocabulary is portals and documents, and record-level accounting stays in Data →
// Review, which is where the count links.
//
// "CHECKED" IS RESERVED. It renders here only from `checkedAt` — the sticky clock
// stamped solely by a report that COUNTS AS A CHECK — never from a stamp a delivery
// advanced. The per-patient chips (which #1888 deliberately keeps advancing on a
// delivery) say "Last synced" for the same reason.

import { dataSectionHref, type AppRoute } from "./hrefs";

export type PortalStatusTone = "ok" | "attention" | "idle";

// One piece of a login row's sentence. Only the delivered-document COUNT is ever a
// link, and the row renders the pieces in order — the module keeps owning the whole
// sentence (and its unit tests keep pinning every branch) while the surface decides
// nothing beyond how a link looks.
export type PortalStatusSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: AppRoute };

export interface PortalLoginStatus {
  tone: PortalStatusTone;
  // The whole sentence as plain text — what a non-linking reader (a test, an aria
  // label) sees. Always the concatenation of `segments`, so the two cannot disagree.
  text: string;
  segments: PortalStatusSegment[];
}

// The slice of an account-level run report this needs — structural, so the pure module
// never imports the DB layer that produces it.
export interface PortalRunLike {
  at: string;
  ok: boolean;
  // The tool's own failure line, or null. Free text from an authenticated but untrusted
  // tool — render as text, never as markup.
  message: string | null;
  // Did this report describe a VISIT to the portal (#1888)? Absent-means-true on the
  // wire and stored that way, so an old row reads as the contact it always was.
  contacted: boolean;
  // The login's sticky CHECK clock (#1888) — the last report that answered a request.
  // Null means the portal has never actually been checked. Never advanced by a
  // delivery, which is the whole reason this can be stated beside one.
  checkedAt: string | null;
  // Documents this login is credited with delivering on the report's day. See
  // deliveredDocumentCountsByAccount (lib/portal-visibility.ts) for why the aggregate
  // is day-grain — the same grain as the sentence that renders it. OPTIONAL so a
  // PortalRunReport stays structurally assignable here: a caller with no count has no
  // count to state, and the row says "Delivered no documents" rather than inventing one.
  delivered?: number;
}

function day(stamp: string): string {
  return stamp.slice(0, 10);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function plain(tone: PortalStatusTone, text: string): PortalLoginStatus {
  return { tone, text, segments: [{ kind: "text", text }] };
}

function joined(
  tone: PortalStatusTone,
  segments: PortalStatusSegment[]
): PortalLoginStatus {
  return { tone, text: segments.map((s) => s.text).join(""), segments };
}

// What a delivery-only row says about the portal visit it did NOT make. Appended only
// when the check clock actually LAGS the delivery: when a genuine check landed the same
// day, the row would only be restating its own date.
function checkClockSuffix(report: PortalRunLike): string {
  if (report.checkedAt === null) return " · portal never checked";
  const checked = day(report.checkedAt);
  return checked < day(report.at) ? ` · portal last checked ${checked}` : "";
}

// One login's last reported run, as its row states it. `null` means the login has never
// reported at all — honest idle, not failure: this integration is attended, so a quiet
// login is a login nobody has run yet, not a broken one.
export function portalLoginStatus(
  report: PortalRunLike | null
): PortalLoginStatus {
  if (!report) {
    return plain("idle", "No run reported yet.");
  }
  if (!report.ok) {
    return plain(
      "attention",
      report.message
        ? sentence(`Last run failed ${day(report.at)}: ${report.message}`)
        : `Last run failed ${day(report.at)}.`
    );
  }
  // A DELIVERY, not a visit (#1888/#2914). The tool shipped records already on disk and
  // opened no portal, so the row names the delivery — never "run", which on this page
  // means the portal was read.
  if (!report.contacted) {
    const suffix = checkClockSuffix(report);
    const delivered = report.delivered ?? 0;
    if (delivered <= 0) {
      // The run kind is still stated. A delivery that re-offered only documents allos
      // already holds genuinely delivered nothing new, and saying so is the honest
      // reading — there is nothing to link to.
      return plain("ok", `Delivered no documents ${day(report.at)}${suffix}`);
    }
    return joined("ok", [
      { kind: "text", text: "Delivered " },
      {
        kind: "link",
        text: `${delivered} ${delivered === 1 ? "document" : "documents"}`,
        href: dataSectionHref("review"),
      },
      { kind: "text", text: ` ${day(report.at)}${suffix}` },
    ]);
  }
  // A run that found nothing new still counts as a check — that is the point of the
  // every-run report: a quiet week reads as healthy rather than broken.
  return plain("ok", `Last run ${day(report.at)}`);
}
