// Pure phrasing helpers for "how recently / how much was this used" — shared by
// the equipment detail page's usage payoff (issue #343) and the protocol
// usage-during-window line (issue #344), so "23 sessions · last 3 days ago" reads
// the same wherever it appears (one question, one computation → one phrasing).
// No DB/network; unit-tested in lib/__tests__/usage-format.test.ts.

import { daysBetweenDateStr } from "./date";

// "today" / "yesterday" / "N days ago" for a last-used date relative to `today`
// (both YYYY-MM-DD). Null/unparseable/future → "never". Deterministic.
export function formatLastUsed(
  lastUsed: string | null | undefined,
  today: string
): string {
  if (!lastUsed) return "never";
  const days = daysBetweenDateStr(lastUsed, today);
  if (days == null || days < 0) return "never";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// "N sessions" with singular/plural, or "no sessions yet" for zero.
export function formatSessionCount(sessions: number): string {
  if (sessions <= 0) return "no sessions yet";
  return `${sessions} ${sessions === 1 ? "session" : "sessions"}`;
}

// The compact combined summary: "23 sessions · last 3 days ago" (or just
// "no sessions yet" when there are none). `today` anchors the relative phrasing.
export function formatUsageSummary(
  sessions: number,
  lastUsed: string | null | undefined,
  today: string
): string {
  if (sessions <= 0) return "no sessions yet";
  return `${formatSessionCount(sessions)} · last ${formatLastUsed(lastUsed, today)}`;
}
