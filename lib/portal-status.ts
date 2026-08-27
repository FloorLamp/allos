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
import { dateFromCreatedAt } from "./timeline-format";

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
  // What this login most recently delivered, and the day the archives landed. See
  // deliveredDocumentCountsByAccount (lib/portal-visibility.ts) for why the count is the
  // documents themselves and why the day is the DELIVERY's rather than the report's — a
  // push that straddles UTC midnight files its last report on the far side of it, and the
  // sentence should name the day the archives arrived. OPTIONAL so a PortalRunReport
  // stays structurally assignable here: a caller with no count has no count to state, and
  // the row says "Delivered no documents" rather than inventing one.
  delivered?: { count: number; day: string } | null;
}

// The PROFILE-LOCAL calendar day a stored run instant fell on (#3573). `at` and
// `checkedAt` are instants — SQLite's bare "YYYY-MM-DD HH:MM:SS" on the older rows,
// the canonical "…Z" form on the newer ones — and this used to take the first ten
// characters, which is the UTC day and nobody's local one. A run reported at 19:00
// in UTC−07:00 printed TOMORROW's date on a page whose whole job is telling a
// household when their portal was last read. The fallback is the old truncation and
// only for a stamp that will not parse: a row that cannot become an instant has no
// local day to state, and printing nothing where a date belongs is worse than
// printing the stored prefix.
function day(stamp: string, timeZone: string): string {
  return dateFromCreatedAt(stamp, timeZone) ?? stamp.slice(0, 10);
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
function checkClockSuffix(
  report: PortalRunLike,
  on: string,
  timeZone: string
): string {
  if (report.checkedAt === null) return " · portal never checked";
  const checked = day(report.checkedAt, timeZone);
  return checked < on ? ` · portal last checked ${checked}` : "";
}

// One login's last reported run, as its row states it. `null` means the login has never
// reported at all — honest idle, not failure: this integration is attended, so a quiet
// login is a login nobody has run yet, not a broken one.
// `timeZone` is REQUIRED and threaded rather than resolved here (#3573): this module
// is pure by design — no DB, no login — so the caller, which knows whose page this is,
// supplies the zone. Defaulting it would put a silent UTC back one layer down.
export function portalLoginStatus(
  report: PortalRunLike | null,
  timeZone: string
): PortalLoginStatus {
  if (!report) {
    return plain("idle", "No run reported yet.");
  }
  if (!report.ok) {
    return plain(
      "attention",
      report.message
        ? sentence(`Last run failed ${day(report.at, timeZone)}: ${report.message}`)
        : `Last run failed ${day(report.at, timeZone)}.`
    );
  }
  // A DELIVERY, not a visit (#1888/#2914). The tool shipped records already on disk and
  // opened no portal, so the row names the delivery — never "run", which on this page
  // means the portal was read.
  if (!report.contacted) {
    const delivered = report.delivered ?? null;
    // The day the ARCHIVES landed when there are any, and the report's own day when the
    // delivery carried nothing — there is no delivery day to name in that case.
    //
    // MIXED GRAIN, KNOWINGLY (#3573). `delivered.day` is grouped UTC-side by
    // `substr(delivered_at, 1, 10)` in deliveredDocumentCountsByAccount, which #3573
    // holds out of scope — that is the SQL truncation family, a different question. So
    // on a delivery-only report this branch can pair a UTC delivery day with the local
    // check day below, and `checked < on` can therefore compare across grains for the
    // few hours a household sits either side of UTC midnight. Converting it means moving
    // the per-day grouping out of SQL, which is a larger change than this sweep; the
    // report's OWN day, which every other branch names, is now correct.
    const on =
      delivered && delivered.count > 0 ? delivered.day : day(report.at, timeZone);
    const suffix = checkClockSuffix(report, on, timeZone);
    if (!delivered || delivered.count <= 0) {
      // The run kind is still stated. A delivery that re-offered only documents allos
      // already holds genuinely delivered nothing new, and saying so is the honest
      // reading — there is nothing to link to.
      return plain("ok", `Delivered no documents ${on}${suffix}`);
    }
    const n = delivered.count;
    return joined("ok", [
      { kind: "text", text: "Delivered " },
      {
        kind: "link",
        text: `${n} ${n === 1 ? "document" : "documents"}`,
        href: dataSectionHref("review"),
      },
      { kind: "text", text: ` ${on}${suffix}` },
    ]);
  }
  // A run that found nothing new still counts as a check — that is the point of the
  // every-run report: a quiet week reads as healthy rather than broken.
  return plain("ok", `Last run ${day(report.at, timeZone)}`);
}
