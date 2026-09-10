// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960 / rule #5670. The profile-scoping guard walks all of lib/, so this module
// stays covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
//
// THE DOSE-HISTORY AND LEDGER READS — every surface that renders what was already
// taken: the med card's day list, its batched form for the Today panel, one item's
// history, the batched history for the supplements tab, the whole-profile history and
// the server-paged ledger.
//
// They cut together because they share `DOSE_HISTORY_ORDER` (#2417), and sharing that
// string is the point: three readers answer the same question at three scopes and must
// order identically, so a row cannot appear in one place and rank differently in
// another. A shared constant makes disagreement physically impossible rather than
// merely true today — which only holds while the readers sit in one file that owns it.
//
// Reads only. Nothing here writes the ledger, and the ordering's pairing of the
// administration event with the immutable capture is a DISPLAY fallback: rows whose
// event was never stated still sort beside the day they happened on.
import { db } from "../../db";
import { clampPage, pageCount, pageOffset } from "../../pagination";
import type { IntakeItemKind } from "../../types";

// The day's PRN administrations for one item, most-recent first — for the med
// card's "2 today · last 4:02pm" line. `recorded_at` is the immutable tap and
// `occurred_at` is the administration instant (falling back to the tap when unstated).
// Profile-scoped via the parent item (the denormalized
// item_id, kept consistent by migration 011).
export function getAdministrationsForItemOnDate(
  profileId: number,
  itemId: number,
  date: string
): {
  id: number;
  occurred_at: string | null;
  recorded_at: string;
  amount: string | null;
  product: string | null;
}[] {
  return db
    .prepare(
      `SELECT l.id, l.occurred_at, l.recorded_at, l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.date = ?
          AND l.status = 'taken'
        ORDER BY COALESCE(l.occurred_at, l.recorded_at) DESC, l.id DESC`
    )
    .all(profileId, itemId, date) as {
    id: number;
    occurred_at: string | null;
    recorded_at: string;
    amount: string | null;
    product: string | null;
  }[];
}

// Batched form of getAdministrationsForItemOnDate for the medications Today panel
// (#885): the day's PRN administrations for a SET of items in one query, grouped into a
// Map<itemId, admins[]>, so the card builder derives each PRN med's day-summary in JS
// instead of issuing one query per PRN item (an N+1 over the append-only, un-purged
// intake_item_logs ledger). Same per-item ordering (most-recent intake first) and same
// profile-scoping via the parent item as the single-item version. Empty ids → empty map.
export function getAdministrationsForItemsOnDate(
  profileId: number,
  itemIds: number[],
  date: string
): Map<
  number,
  {
    id: number;
    occurred_at: string | null;
    recorded_at: string;
    amount: string | null;
    product: string | null;
  }[]
> {
  const out = new Map<
    number,
    {
      id: number;
      occurred_at: string | null;
      recorded_at: string;
      amount: string | null;
      product: string | null;
    }[]
  >();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT l.item_id, l.id, l.occurred_at, l.recorded_at, l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders}) AND l.date = ?
          AND l.status = 'taken'
        ORDER BY COALESCE(l.occurred_at, l.recorded_at) DESC, l.id DESC`
    )
    .all(profileId, ...itemIds, date) as {
    item_id: number;
    id: number;
    occurred_at: string | null;
    recorded_at: string;
    amount: string | null;
    product: string | null;
  }[];
  for (const r of rows) {
    const arr = out.get(r.item_id) ?? [];
    arr.push({
      id: r.id,
      occurred_at: r.occurred_at,
      recorded_at: r.recorded_at,
      amount: r.amount,
      product: r.product,
    });
    out.set(r.item_id, arr);
  }
  return out;
}

// The ONE ordering every dose-history reader sorts by (#2417). Three readers answer
// the same question at three scopes — one item (getIntakeDoseHistory), a page's worth
// of items (getIntakeDoseHistoryForItems), and the whole profile
// (getIntakeDoseHistoryAll) — and they MUST sort identically: the cross-item ledger
// narrowed to one item is asserted row-for-row against the item-scoped reader, so a
// drifted ORDER BY in any one of them is a broken surface, not a cosmetic difference.
// Sharing the string is what makes that physically impossible rather than merely true
// today.
//
const DOSE_HISTORY_ORDER =
  "ORDER BY l.date DESC, COALESCE(l.occurred_at, l.recorded_at) DESC, l.id DESC";

// One taken ledger row as the dose-history surfaces render it. It carries the row's
// declared temporal columns — `occurred_at` (the event instant) alongside the immutable
// `recorded_at` tap — so a caller can ask
// lib/row-instants.ts the row-level question instead of pairing columns by hand, and
// so an unstated row can render "recorded 7:02am" rather than a bare clock (#2228
// decision 4). A type alias rather than an interface so it satisfies the readers'
// `Record<string, unknown>` row parameter structurally.
export type IntakeDoseHistoryRow = {
  id: number;
  dose_id: number;
  date: string;
  occurred_at: string | null;
  recorded_at: string;
  amount: string | null;
  product: string | null;
};

// Taken-dose history for one item's history surface: scheduled and PRN ledger rows
// on/after `sinceDate`, most recent first. The medication detail page passes its
// earliest course date for bounded scheduled courses and the ISO floor for
// open-ended/PRN history. Returns exact intake time + snapshotted amount for
// formatting at the call site. Kind-neutral (it was getIntakeDoseHistory until
// #1933, when the supplements surface gained the same history panel).
export function getIntakeDoseHistory(
  profileId: number,
  itemId: number,
  sinceDate: string
): IntakeDoseHistoryRow[] {
  return db
    .prepare(
      `SELECT l.id, l.dose_id, l.date, l.occurred_at, l.recorded_at,
              l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id = ? AND l.status = 'taken'
          AND l.date >= ?
        ${DOSE_HISTORY_ORDER}`
    )
    .all(profileId, itemId, sinceDate) as IntakeDoseHistoryRow[];
}

// Batched form of getIntakeDoseHistory for the supplements tab (#1933): every listed
// item's recent taken rows in ONE query, grouped into a Map<itemId, rows[]>, so a page
// rendering dozens of supplement rows doesn't issue one history query per item (the
// #885 treatment of the same N+1 over this append-only ledger). Same ordering and same
// profile-scoping through the parent item as the single-item read. Empty ids → empty map.
export function getIntakeDoseHistoryForItems(
  profileId: number,
  itemIds: number[],
  sinceDate: string
): Map<number, IntakeDoseHistoryRow[]> {
  const out = new Map<number, IntakeDoseHistoryRow[]>();
  if (itemIds.length === 0) return out;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT l.id, l.dose_id, l.item_id, l.date, l.occurred_at, l.recorded_at,
              l.amount, l.product
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.item_id IN (${placeholders})
          AND l.status = 'taken' AND l.date >= ?
        ${DOSE_HISTORY_ORDER}`
    )
    .all(profileId, ...itemIds, sinceDate) as (IntakeDoseHistoryRow & {
    item_id: number;
  })[];
  for (const r of rows) {
    const arr = out.get(r.item_id) ?? [];
    arr.push({
      id: r.id,
      dose_id: r.dose_id,
      date: r.date,
      occurred_at: r.occurred_at,
      recorded_at: r.recorded_at,
      amount: r.amount,
      product: r.product,
    });
    out.set(r.item_id, arr);
  }
  return out;
}

// One row of the CROSS-ITEM dose ledger (#2417): the same taken-row shape the
// item-scoped reads return, plus the identity of the item it was taken against.
export type IntakeDoseLedgerRow = IntakeDoseHistoryRow & {
  item_id: number;
  item_name: string;
  item_kind: IntakeItemKind;
};

// The cross-item dose ledger: every taken row this profile recorded in a window,
// newest first, with the item's name and kind joined in (#2417).
//
// The third member of this family, and deliberately not a fork of it: the same
// `status = 'taken'` semantics (a skip is adherence's business, not the record of
// what was actually taken), the LITERALLY same ordering (`DOSE_HISTORY_ORDER`, shared
// by all three readers), and the same profile scoping through the parent item. What it
// adds is that the QUESTION is no longer item-scoped — "what did I actually take last
// week, across items" used to cost one navigation per item.
//
// The JOIN is on the item's PROFILE ONLY — never on `active`. History outlives
// retirement: a dose taken from a bottle that has since been paused, retired, or
// swapped still happened, and dropping it here would silently rewrite the record.
//
// `itemId` is offered so the ledger's item filter narrows in SQL rather than by
// post-filtering the window; narrowed to one item it returns exactly the rows
// `getIntakeDoseHistory` returns for that item over the same window (asserted in
// lib/__db_tests__/supplement-dose-history.test.ts), which is what lets the ledger
// and the per-item panel be two views of one ledger instead of two answers.
export interface IntakeDoseLedgerFilters {
  kind?: IntakeItemKind;
  itemId?: number;
  // Inclusive last day of the window; omit for "up to the newest row".
  untilDate?: string;
}

// The optional narrowing clauses, in the order their params are bound. The profile
// scope is NEVER built here — it stays spelled out in each statement's own text
// below, so the profile-scoping guard can read the query and so no future filter can
// accidentally replace the join condition that makes it this profile's ledger.
function doseLedgerFilters(opts: IntakeDoseLedgerFilters): {
  sql: string;
  params: (string | number)[];
} {
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (opts.untilDate) {
    filters.push(" AND l.date <= ?");
    params.push(opts.untilDate);
  }
  if (opts.kind) {
    filters.push(" AND s.kind = ?");
    params.push(opts.kind);
  }
  if (opts.itemId) {
    filters.push(" AND l.item_id = ?");
    params.push(opts.itemId);
  }
  return { sql: filters.join(""), params };
}

export function getIntakeDoseHistoryAll(
  profileId: number,
  sinceDate: string,
  opts: IntakeDoseLedgerFilters = {}
): IntakeDoseLedgerRow[] {
  const filters = doseLedgerFilters(opts);
  return db
    .prepare(
      `SELECT l.id, l.dose_id, l.item_id, l.date, l.occurred_at, l.recorded_at,
              l.amount, l.product,
              s.name AS item_name, s.kind AS item_kind
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.status = 'taken' AND l.date >= ?${filters.sql}
        ${DOSE_HISTORY_ORDER}`
    )
    .all(profileId, sinceDate, ...filters.params) as IntakeDoseLedgerRow[];
}

export interface IntakeDoseLedgerPage {
  rows: IntakeDoseLedgerRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ONE page of that ledger, plus the total the pager needs.
//
// This is what the dose-history SURFACE reads (#2445). Its date range offers an
// explicit "All time", which passes the ISO floor as `sinceDate` — a window with no
// lower bound — and the reader above has no LIMIT, so a twice-daily medication kept
// for years fetched and rendered thousands of rows on that tap. A range control is a
// filter, not a bound: "all time" is a legitimate answer here (history outlives
// retirement, and a dose taken years ago still happened), so the bound has to be the
// page, and the page has to reach the SQL rather than only the DOM.
//
// The unpaged reader stays for callers that genuinely want the whole window in one
// array — and as the row-for-row cross-check against the per-item panel — but nothing
// that RENDERS the ledger should use it.
export function getIntakeDoseLedgerPage(
  profileId: number,
  sinceDate: string,
  opts: IntakeDoseLedgerFilters,
  page: number,
  pageSize: number
): IntakeDoseLedgerPage {
  const size = Math.max(1, Math.trunc(pageSize));
  const filters = doseLedgerFilters(opts);
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE s.profile_id = ? AND l.status = 'taken' AND l.date >= ?${filters.sql}`
      )
      .get(profileId, sinceDate, ...filters.params) as { n: number }
  ).n;
  const clamped = Math.min(clampPage(page), pageCount(total, size));
  const rows = db
    .prepare(
      `SELECT l.id, l.dose_id, l.item_id, l.date, l.occurred_at, l.recorded_at,
              l.amount, l.product,
              s.name AS item_name, s.kind AS item_kind
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.status = 'taken' AND l.date >= ?${filters.sql}
        ${DOSE_HISTORY_ORDER}
        LIMIT ? OFFSET ?`
    )
    .all(
      profileId,
      sinceDate,
      ...filters.params,
      size,
      pageOffset(clamped, size)
    ) as IntakeDoseLedgerRow[];
  return { rows, total, page: clamped, pageSize: size };
}
