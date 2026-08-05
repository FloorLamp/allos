// Portal SYNC REQUESTS — the pure half (issue #1757).
//
// ── WHY A REQUEST, NOT A TRIGGER ─────────────────────────────────────────────
//
// A portal run needs a PERSON at a specific machine — two-factor codes, sessions that
// idle out in minutes — so the trigger's job is to reach a person, not a machine. The
// transports that were once phase 2 (a URL scheme, a resident agent) only save the final
// click; everything before that click — knowing a run is due, telling the right person,
// closing the loop — is a notification problem allos already has machinery for. This
// module is the decision layer for that, and it deliberately produces no side effects a
// tool can observe.
//
// THE THREE SETTLED CONSTRAINTS (#1739), inherited from birth:
//
//   A REQUEST IS NEVER A SCHEDULE. Nothing here promises a run will happen at a time.
//   It records that one is WANTED, and the person decides when they are at the machine.
//
//   IT EXPIRES RATHER THAN HANGS. Every request carries an `expires_at` from creation.
//   A nudge nobody acted on becomes silence, not a permanent badge — the failure mode
//   that trains people to ignore badges.
//
//   SLUGS ONLY, NEVER A URL. A request names `(portal, account)` by allos-minted slug.
//   There is no address in this feature, in this module, or in the table it drives.
//
// ── THE REQUEST ANSWERS ITSELF ───────────────────────────────────────────────
//
// A request for `(ochsner, mom)` is satisfied by the next ANSWERING report naming that
// pair. There is still no acknowledgment protocol, no claim state and no cleanup burden:
// the row just WATCHES for the report the phase-1 contract already sends. (A tool may now
// READ the open list — #1889 — but it cannot write one, close one, or claim one.)
//
// A FAILED ATTENDED run counts as answered, and so does a refusal-path report. The person
// acted — they went to the machine and ran the tool. Whether the run then succeeded is the
// sync STATUS's story (the card's "last run failed" line, Data → Review's badge), and
// letting the request re-ask would nag someone for a thing they just did.
//
// TWO REPORTS DO NOT ANSWER, and both are the same mistake from different sides:
//
//   A DELIVERY-ONLY REPORT (#1888). The acquirer's `push` command ships records already
//   on disk and contacts no portal at all. It answered the request and reset the
//   staleness clock, so an unchecked portal looked checked — the one input that can make
//   allos forget on the user's behalf while telling them everything is fine.
//
//   A FAILED UNATTENDED RUN (#1889). "The person acted" is exactly right for a person and
//   exactly wrong for a task. A scheduled run whose device-trust cookie expired has had
//   nobody act on it — and that is precisely when somebody DOES need to go to the machine.
//   Answering there makes the ask disappear at the exact point it became true.
//
// A SUCCESSFUL unattended run still answers: records arrived, which is all the request
// ever wanted. The decision is one pure predicate (`reportAnswersRequest`,
// lib/acquirer-identity.ts), applied once at ingest.
//
// ── OPENNESS IS DERIVED, NEVER STORED ────────────────────────────────────────
//
// There is no `answered_at`, no `state` column, and no write on the report path to keep
// consistent. A request is OPEN when it has not expired AND no run report for its
// account is at-or-after its `created_at`. Both halves are pure comparisons over values
// the caller already has, which is why they live here and are unit-tested without a
// database.

import { parseUtcSql, utcSqlString, daysBetweenDateStr } from "./date";

// ── Vocabulary ───────────────────────────────────────────────────────────────

// The three ways a request comes to exist. Stored verbatim in the table's CHECK, so this
// list and migration 133's enum are the same closed set.
export const SYNC_REQUEST_REASONS = [
  // A per-portal cadence: "Ochsner unchecked for 30 days".
  "staleness",
  // A mapped profile's visit just happened — the moment new records actually appear on a
  // portal, and the highest-value nudge this feature can send.
  "post-visit",
  // The card's "Request sync" button — for when the person who manages allos is not the
  // person whose laptop holds the portal login.
  "manual",
] as const;

export type SyncRequestReason = (typeof SYNC_REQUEST_REASONS)[number];

export function isSyncRequestReason(v: string): v is SyncRequestReason {
  return (SYNC_REQUEST_REASONS as readonly string[]).includes(v);
}

// ── Constants ────────────────────────────────────────────────────────────────

// The default staleness cadence. A NAMED CONSTANT, not a setting: per-portal overrides
// are deliberate later work (#1757), and shipping a knob before anyone has felt the
// default is how a settings page fills up with questions nobody can answer.
export const STALENESS_CADENCE_DAYS = 30;

// How long a request stays open. One week: long enough to survive a work trip, short
// enough that an unacted nudge becomes silence rather than a permanent badge. A request
// created today therefore reads "expires in 6 days" tomorrow — the card's copy.
export const SYNC_REQUEST_TTL_DAYS = 7;

// How recently a visit must have happened to raise a post-visit request. Portals do not
// publish a visit's documents the same afternoon; three days is the window in which "the
// portal likely has new results" is honest rather than optimistic.
export const POST_VISIT_WINDOW_DAYS = 3;

// The suppression-bus namespace (registered in lib/rule-finding-prefixes.ts).
export const SYNC_REQUEST_PREFIX = "portal-sync:";

// ── Identity ─────────────────────────────────────────────────────────────────

// The ONE dedupe key every surface uses: the Upcoming item, the digest line, and the
// dismissal row are the same identity, so a dismiss on either surface silences both
// (the #221 one-computation guarantee).
//
// ANCHORED ON THE REQUEST'S CREATION DAY, deliberately — the same shape #1682's
// per-period cycle key uses. The table holds ONE row per portal login (see
// supersedesOpenRequest), so a row-id key would be stable forever and a single dismiss
// would silence portal hygiene for that login permanently. Anchoring on the day the
// request was raised makes a dismissal mean "not this ask", and the NEXT ask — a new
// staleness cycle, a new visit — is a new key that surfaces again.
export function syncRequestDedupeKey(
  portalSlug: string,
  accountSlug: string,
  createdAt: string
): string {
  return `${SYNC_REQUEST_PREFIX}${portalSlug}/${accountSlug}:${dayOf(createdAt)}`;
}

// The calendar day of a stored `YYYY-MM-DD HH:MM:SS` stamp (or of a bare date).
function dayOf(stamp: string): string {
  return stamp.slice(0, 10);
}

// ── Lifecycle: expiry, answering, openness ───────────────────────────────────

// The pure shape of a stored request. The DB layer hydrates this; nothing here needs a
// row id, and nothing here has ever seen an address.
export interface SyncRequestFacts {
  reason: SyncRequestReason;
  createdAt: string;
  expiresAt: string;
}

// `created_at + TTL`, as a SQL-shaped UTC stamp. Computed in JS from the SAME stamp the
// row is written with, so a row's two timestamps can never disagree about which clock
// they came from.
export function syncRequestExpiresAt(
  createdAt: string,
  ttlDays: number = SYNC_REQUEST_TTL_DAYS
): string {
  const at = parseUtcSql(createdAt);
  if (!at) return createdAt;
  return utcSqlString(new Date(at.getTime() + ttlDays * 86_400_000));
}

// Expired: `now` is at or past the stamp. At-or-past rather than past, so the boundary
// second belongs to expiry — a request must never outlive its own deadline by a tick.
export function isSyncRequestExpired(expiresAt: string, now: string): boolean {
  return now >= expiresAt;
}

// Answered: SOME ANSWERING report for this portal login landed at or after the request
// was raised. `lastReportAt` is the account's most recent answering stamp — a sticky
// column stamped through `reportAnswersRequest` at ingest, which only ever moves forward,
// so "the last answering report is newer than the request" is exactly "a report answered
// it".
//
// The report's OUTCOME is still deliberately not a parameter HERE. Which reports answer
// is decided ONCE, at the boundary, by the one pure predicate — never re-derived by each
// surface that asks whether a request is open. A nothing-new run answers, an attended
// failure answers, a delivery-only push and an unattended failure do not.
export function isSyncRequestAnswered(
  createdAt: string,
  lastReportAt: string | null
): boolean {
  return lastReportAt != null && lastReportAt >= createdAt;
}

// Open = not expired and not answered. The only definition; every surface reads it.
export function isSyncRequestOpen(
  req: SyncRequestFacts,
  lastReportAt: string | null,
  now: string
): boolean {
  return (
    !isSyncRequestExpired(req.expiresAt, now) &&
    !isSyncRequestAnswered(req.createdAt, lastReportAt)
  );
}

// Whole days until a request expires, from a calendar day. Negative once past.
export function daysUntilExpiry(expiresAt: string, today: string): number {
  return daysBetweenDateStr(today, dayOf(expiresAt)) ?? 0;
}

// ── Creation: one open request per portal login ──────────────────────────────
//
// THE KEY IS THE ACCOUNT. One row per portal LOGIN, keyed by `account_id`, exactly as
// migration 132's run-report table is — and for the same reason: it makes the table
// BOUNDED BY CONSTRUCTION. A staleness evaluator running hourly forever, a household
// pressing "Request sync" all afternoon, a busy week of visits — all of them rewrite one
// row per portal login. There is no retention sweep to own and no way to grow the table
// by asking.
//
// It is also the honest grain for the ACTION. The thing a request asks for is "go run
// the portal tool for this login". That errand is the same errand whether a timer, a
// visit, or a person raised it, and two Upcoming items telling one person to do one
// thing twice is noise, not reach.
//
// WHICH REASON WINS. A new request replaces an open one only when it is more SALIENT:
//
//   manual (3)     — a person explicitly asked, just now. Never swallowed, never
//                    downgraded; it also refreshes the clock, because the ask is new.
//   post-visit (2) — evidence-backed: records probably exist right now.
//   staleness (1)  — the weakest signal, a timer with no evidence behind it.
//
// A weaker reason arriving while a stronger request is open is a NO-OP, not a second
// row: the person has already been asked to do exactly this errand, and re-stamping it
// with a lesser reason would both re-word the ask and (through the day-anchored key)
// resurrect a nudge they dismissed. Once the open request is answered or expired, any
// reason may create afresh.

const REASON_SALIENCE: Record<SyncRequestReason, number> = {
  staleness: 1,
  "post-visit": 2,
  manual: 3,
};

export function syncRequestSalience(reason: SyncRequestReason): number {
  return REASON_SALIENCE[reason];
}

// Should `incoming` be written? True when there is no request at all, when the existing
// one is no longer open, or when the incoming reason is strictly more salient.
export function shouldWriteSyncRequest(
  existing: SyncRequestFacts | null,
  existingOpen: boolean,
  incoming: SyncRequestReason
): boolean {
  if (!existing || !existingOpen) return true;
  return syncRequestSalience(incoming) > syncRequestSalience(existing.reason);
}

// ── The setup carve-out (#2010) ──────────────────────────────────────────────
//
// NO AUTOMATIC ASK BEFORE THE TOOL HAS EVER RUN. Every automatic creator below shares one
// assumption — the tool is installed, pointed at this login, and merely due (or newly
// worth) another run. A household still in SETUP owes something else entirely: install
// the tool, mint a token, run it once. The page's own checklist says exactly that, in
// better words, and a push telling that household it is "overdue for a routine check"
// contradicts the page it links to.
//
// WHY `mappedPatients` DOES NOT ANSWER THIS. It was the proxy, and it only holds under
// "a mapped identity implies a run already happened". That is false BY DESIGN: the card
// ships a hand pre-bind ("bind a label you know exactly, spelled the way the portal
// spells it") precisely so the first run files records straight away instead of dumping
// them into pending. One pre-bound label on a portal whose tool was never installed is
// `mapped = 1`, and it used to be enough to start nagging.
//
// WHAT `everRan` MUST READ. Raw existence of a run report for this login, NOT the check
// clock. `lastReportAt`/`lastOkAt` are stamped through `reportCountsAsCheck`, which
// deliberately excludes a delivery-only push — but a delivery-only push still proves the
// tool exists and is pointed here, so it ENDS the setup carve-out while leaving the
// staleness clock untouched. The two questions are different, so they read different
// columns; reusing the check-clock constant here would be the exact confusion that
// constant exists to prevent (#1888).
//
// NOT THE STAGE MACHINE. `portalSetupStage` is tempting and wrong: `map-patients`
// outranks everything but the empty registry, so a long-running household that picks up
// one new pending patient drops out of `steady` — and silencing staleness there would
// mute the nudge on exactly the households that use the feature most. The narrow
// condition is the stage machine's PRE-RUN band (`create-token` / `first-run`), which is
// `reportCount <= 0` and nothing else. Do not "simplify" this to a stage check.
//
// MANUAL IS EXEMPT, and stays that way. A person pressing "Request sync" has decided for
// themselves; the attention doctrine lets the system reduce contact unilaterally, never
// overrule a user's own action.
export function mayAutoRequestSync(input: { everRan: boolean }): boolean {
  return input.everRan;
}

// ── Staleness ────────────────────────────────────────────────────────────────

// Should a staleness request be raised for this portal login?
//
// SILENT BEFORE THE FIRST RUN, first of all — the shared carve-out above, so this rule
// and the post-visit creator can never disagree about what "still in setup" means.
//
// SILENT WITHOUT MAPPED PATIENTS, unconditionally and first. A portal login with nothing
// bound to a profile has no profile whose Upcoming could carry the nudge and no
// household member the routing could name — so a request there would be an unreachable
// row, and worse, it would nag about a setup step ("map these patients") the card
// already asks for in its own words. First contact is the card's job, not this one's.
//
// NEVER CHECKED counts as stale — and this clause survives the carve-out above, because
// the two states are different. A login whose tool RUNS and keeps failing has
// `lastCheckedAt = null` forever, and that household genuinely needs the nudge: doing the
// first run is the setup step, failing it is a hygiene problem.
export function isStalenessDue(input: {
  // Has the tool ever reported a run on this login at all — any row, including a
  // delivery-only push. See `mayAutoRequestSync`.
  everRan: boolean;
  mappedPatients: number;
  lastCheckedAt: string | null;
  today: string;
  cadenceDays?: number;
}): boolean {
  if (!mayAutoRequestSync(input)) return false;
  if (input.mappedPatients <= 0) return false;
  if (!input.lastCheckedAt) return true;
  const days = daysBetweenDateStr(dayOf(input.lastCheckedAt), input.today);
  if (days == null) return false;
  return days >= (input.cadenceDays ?? STALENESS_CADENCE_DAYS);
}

// ── Copy ─────────────────────────────────────────────────────────────────────
//
// ONE FORMATTER, so the Upcoming item, the digest line and the card phrase the ask
// identically. The copy NAMES THE ACTION A PERSON TAKES — "run the portal tool on the
// computer with Mom's login" — rather than describing a state ("sync overdue"), because
// the whole premise is that a machine cannot do this and a person must.
//
// The login is named only when it is worth naming: a single-login household never meets
// the account concept (migration 131's implicit account), so the phrase collapses to
// "run the portal tool" rather than "…with the Default login's account".

export interface SyncRequestCopyInput {
  portalName: string;
  accountName: string;
  accountImplicit: boolean;
  reason: SyncRequestReason;
  // Whole days since the login was last checked; null when it never has been. Only the
  // staleness wording uses it.
  daysSinceChecked?: number | null;
  // The visiting person's display name, for the post-visit wording. Omitted → a
  // subject-less phrasing rather than an invented name.
  visitSubject?: string | null;
  // THE MACHINE ALREADY TRIED (#1889). Present when the last thing to happen on this
  // login was a scheduled run failing with nobody at the keyboard. It is ONE OPTIONAL
  // CLAUSE on this one formatter — never a second formatter — because it is the same ask
  // with a better reason attached: the request is open BECAUSE the unattended run could
  // not finish, and the person needs to know it is their turn and why.
  //
  // The message is the tool's own free text (`{ message: null }` when it gave none), so
  // every surface renders it as TEXT, never as markup.
  unattendedFailure?: { message: string | null } | null;
}

export interface SyncRequestCopy {
  title: string;
  detail: string;
  // WHY THE REQUEST IS OPEN, as a short fragment (#1913 item 6 — owner ruling): "never
  // checked", "not checked in 5 weeks", "a visit just happened".
  //
  // `detail` above is written for the CARD, where the title is a heading and this is its
  // supporting line, so it is a complete sentence that restates the portal and repeats
  // the ask. The digest CONCATENATES title and cause into one bullet, so it needs the
  // cause alone — otherwise the line says the imperative twice with two em dashes at
  // different grammatical levels. Same words, same switch, one formatter: this is a
  // second FIELD, not a second set of copy.
  because: string;
  // The card's compact state line ("Sync requested · expires in 6 days").
  cardLine: string;
}

// "the computer with Mom's login" / "your computer" — the machine phrase, once.
function machinePhrase(accountName: string, implicit: boolean): string {
  return implicit
    ? "your computer"
    : `the computer with ${accountName}'s login`;
}

// "5 weeks" / "12 days" — a coarse, honest interval. Weeks past a fortnight because
// "hasn't been checked in 37 days" is a number nobody converts.
function intervalPhrase(days: number): string {
  if (days >= 14) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function syncRequestCopy(input: SyncRequestCopyInput): SyncRequestCopy {
  const where = machinePhrase(input.accountName, input.accountImplicit);
  const title = `Run the portal tool for ${input.portalName}`;
  let detail: string;
  // The same reason, as the fragment the digest's named line concatenates (#1913 item 6).
  // Subject-less by construction: the title has already named the portal.
  let because: string;
  switch (input.reason) {
    case "staleness":
      if (input.daysSinceChecked == null) {
        detail = `${input.portalName} has never been checked — run the portal tool on ${where}.`;
        because = "never checked";
      } else {
        const ago = intervalPhrase(input.daysSinceChecked);
        detail = `${input.portalName} hasn't been checked in ${ago} — run the portal tool on ${where}.`;
        because = `not checked in ${ago}`;
      }
      break;
    case "post-visit":
      detail = input.visitSubject
        ? `${input.visitSubject}'s visit just happened — the portal likely has new results. Run the portal tool on ${where}.`
        : `A visit just happened — the portal likely has new results. Run the portal tool on ${where}.`;
      because = input.visitSubject
        ? `${input.visitSubject}'s visit just happened`
        : "a visit just happened";
      break;
    case "manual":
      detail = `A sync was requested for ${input.portalName} — run the portal tool on ${where}.`;
      because = "a sync was requested";
      break;
  }
  const escalation = unattendedFailureClause(input.unattendedFailure);
  return {
    title,
    detail: escalation ? `${detail} ${escalation}` : detail,
    // #1889's clause rides the fragment too, in its fragment form: when the machine
    // already tried, THAT is why it is the person's turn, and it outranks the staleness
    // the request was originally opened on.
    because: unattendedFailureFragment(input.unattendedFailure) ?? because,
    cardLine: "Sync requested",
  };
}

// "The scheduled run couldn't finish (the portal asked for a code) — someone needs to go
// to the machine." The machine tried; tell the human why it is their turn.
//
// NAMES THE ACTION A PERSON TAKES, like every other sentence here — and says WHY, because
// "it failed" without a cause sends somebody looking for one. A run that gave no reason
// gets the honest short form rather than an invented cause.
function unattendedFailureClause(
  failure: { message: string | null } | null | undefined
): string | null {
  if (!failure) return null;
  const why = failure.message?.trim();
  return why
    ? `The scheduled run couldn't finish (${why}) — someone needs to go to the machine.`
    : "The scheduled run couldn't finish — someone needs to go to the machine.";
}

// The same clause as a CAUSE FRAGMENT for the digest's named line (#1913 item 6): "the
// scheduled run couldn't finish (the portal asked for a code)". No trailing sentence
// about going to the machine — the title already said that, and the fragment is joined
// after it. Null when nothing has attempted the request, which is the ordinary case.
function unattendedFailureFragment(
  failure: { message: string | null } | null | undefined
): string | null {
  if (!failure) return null;
  const why = failure.message?.trim();
  return why
    ? `the scheduled run couldn't finish (${why})`
    : "the scheduled run couldn't finish";
}

// The expiry half of the card line and the item's due text, from the SAME words:
// "expires in 6 days" / "expires tomorrow" / "expires today".
export function syncRequestExpiryPhrase(days: number): string {
  if (days <= 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

// The full card state line: "Sync requested · expires in 6 days".
export function syncRequestCardLine(
  copy: SyncRequestCopy,
  daysLeft: number
): string {
  return `${copy.cardLine} · ${syncRequestExpiryPhrase(daysLeft)}`;
}
