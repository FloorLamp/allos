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
// A request for `(ochsner, mom)` is satisfied by the next run report naming that pair.
// The tool never learns requests exist: no acknowledgment protocol, no claim state, no
// cleanup burden, nothing new on the wire. The row just WATCHES for the report the
// phase-1 contract already sends.
//
// A FAILED run counts as answered, and so does a refusal-path report. The person acted —
// they went to the machine and ran the tool. Whether the run then succeeded is the sync
// STATUS's story (the card's "last run failed" line, Data → Review's badge), and letting
// the request re-ask would nag someone for a thing they just did.
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

// Answered: SOME run report for this portal login landed at or after the request was
// raised. `lastReportAt` is the account's most recent report stamp — the run-report row
// holds only the last run, which is enough: the stamp only ever moves forward, so
// "the last report is newer than the request" is exactly "a report answered it".
//
// The report's OUTCOME is deliberately not a parameter. A failed run answers, a
// refusal-path report answers, a nothing-new run answers. The person went to the machine
// — that is the whole thing a request asks for.
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

// ── Staleness ────────────────────────────────────────────────────────────────

// Should a staleness request be raised for this portal login?
//
// SILENT WITHOUT MAPPED PATIENTS, unconditionally and first. A portal login with nothing
// bound to a profile has no profile whose Upcoming could carry the nudge and no
// household member the routing could name — so a request there would be an unreachable
// row, and worse, it would nag about a setup step ("map these patients") the card
// already asks for in its own words. First contact is the card's job, not this one's.
//
// NEVER CHECKED counts as stale. A login with bound patients and no run at all is the
// clearest possible case of "records are not flowing"; treating a missing timestamp as
// "not yet due" would keep the one household that most needs the nudge silent forever.
export function isStalenessDue(input: {
  mappedPatients: number;
  lastCheckedAt: string | null;
  today: string;
  cadenceDays?: number;
}): boolean {
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
}

export interface SyncRequestCopy {
  title: string;
  detail: string;
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
  switch (input.reason) {
    case "staleness":
      detail =
        input.daysSinceChecked == null
          ? `${input.portalName} has never been checked — run the portal tool on ${where}.`
          : `${input.portalName} hasn't been checked in ${intervalPhrase(
              input.daysSinceChecked
            )} — run the portal tool on ${where}.`;
      break;
    case "post-visit":
      detail = input.visitSubject
        ? `${input.visitSubject}'s visit just happened — the portal likely has new results. Run the portal tool on ${where}.`
        : `A visit just happened — the portal likely has new results. Run the portal tool on ${where}.`;
      break;
    case "manual":
      detail = `A sync was requested for ${input.portalName} — run the portal tool on ${where}.`;
      break;
  }
  return { title, detail, cardLine: "Sync requested" };
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
