// Paging arithmetic and the page sizes the app's bounded reads share.
//
// A BOUND IS A DECISION, and one question gets one computation: a surface that
// promises "page 2 of 9" and a reader that promises `LIMIT ?/OFFSET ?` have to be
// doing the same arithmetic, or the pager offers a page the read cannot return.
// These three functions were the Audit viewer's (lib/audit-actions.ts, #22) and
// were already being imported across domains by the notify-log viewer; they live
// here now so a history table on Trends, a dose ledger and a changelog can share
// them without importing the audit module.
//
// Everything here is PURE — no DB, no request state — so a reader can apply it in
// SQL and a client pager can apply it to an array and get the same answer.

// Coerce an arbitrary (possibly user-supplied) page value to a 1-based integer.
export function clampPage(page: number): number {
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

// The SQL OFFSET for a 1-based page of `pageSize` rows.
export function pageOffset(page: number, pageSize: number): number {
  return (clampPage(page) - 1) * pageSize;
}

// Total number of pages for `total` rows at `pageSize` (at least 1, so an empty
// table still reads as "page 1 of 1").
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

// The page size for a DATED RECORD-HISTORY table — one row per logged event, read
// newest-first, with per-row controls (edit, delete, an edit-lock badge).
//
// ONE number for the family rather than one per surface (#2530/#2445): the sleep↔mood
// history, the Trends body history table and the cross-item dose ledger are the same
// object at three scopes, and a reader who learns the pager on one should not meet a
// differently-sized one on the next. It is deliberately small — these rows are tall,
// and the page is what bounds BOTH the DOM and (where the read is server-paged) the
// query — while the pager's "Showing 1–10 of 812" keeps the full extent honest.
export const HISTORY_PAGE_SIZE = 10;
