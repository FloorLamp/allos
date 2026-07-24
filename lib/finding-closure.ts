// Close the findings loop (issue #1305). A finding is a stateless derivation that just
// STOPS being emitted once the underlying data changes — complete the fitness check a
// "Recheck due" nudge sent you to, fill in the missing birthdate — and it quietly isn't
// there on the next render. Satisfaction was silent; this is the missing acknowledgment.
//
// `withFindingClosure(profileId, prefixes, snapshot, writeFn)` snapshots the named
// builders' ACTIVE findings (by registered dedupeKey PREFIX, suppression-aware), runs the
// write, re-runs the same builders, and returns `{ result, cleared }`. The satisfier
// action declares 1–2 prefixes it can plausibly satisfy (never "all" — the builders are
// cheap, prefix-scoped reads), and toasts from the typed response.
//
// TWO invariants make this honest:
//   • Satisfaction ≠ dismissal — the suppression bus is UNTOUCHED (no rows written, no
//     dedupeKey writes). This is ephemeral UX over the same derivations, computed inside
//     the action's existing transaction context.
//   • Active-suppression awareness — a finding that was dismissed/snoozed (not visible
//     anywhere) is NOT announced as cleared. The diff is over the ACTIVE set (post-
//     activeFindings), matching what the user could actually see.
//
// The pure differ (clearedFindings) and the toast formatter (formatClosureToast) are
// unit-tested; the DB re-run half is covered per satisfier in the DB tier.

import { today } from "./db";
import { activeFindings } from "./findings";
import type { Finding } from "./findings";
import type { SuppressionRecord } from "./upcoming-suppress";
import { getFindingSuppressions } from "./queries/upcoming/suppressions";

// Findings ACTIVE before a write that are no longer active after it — the closure diff,
// by dedupeKey. Pure. Order follows `before`; a dedupeKey appears at most once (a builder
// could in principle emit a key twice — collapse to one cleared line).
export function clearedFindings(
  before: readonly Finding[],
  after: readonly Finding[]
): Finding[] {
  const afterKeys = new Set(after.map((f) => f.dedupeKey));
  const seen = new Set<string>();
  const cleared: Finding[] = [];
  for (const f of before) {
    if (afterKeys.has(f.dedupeKey) || seen.has(f.dedupeKey)) continue;
    seen.add(f.dedupeKey);
    cleared.push(f);
  }
  return cleared;
}

export interface ClosureResult<T> {
  result: T;
  cleared: Finding[];
}

// Run `writeFn` bracketed by an active-findings snapshot for the declared prefixes, and
// report which of those findings the write CLEARED. The snapshot gathers the relevant
// builders' output; this scopes it to the prefixes, filters through the suppression bus,
// diffs pre vs post, and returns the write's own result alongside `cleared`. Zero clears
// (the common case) returns an empty array — the caller toasts nothing.
export function withFindingClosure<T>(
  profileId: number,
  prefixes: readonly string[],
  snapshot: (profileId: number, todayISO: string) => Finding[],
  writeFn: () => T
): ClosureResult<T> {
  const todayISO = today(profileId);
  const scope = (all: Finding[], supp: Map<string, SuppressionRecord>) =>
    activeFindings(
      all.filter((f) => prefixes.some((p) => f.dedupeKey.startsWith(p))),
      supp,
      todayISO
    );

  const before = scope(
    snapshot(profileId, todayISO),
    getFindingSuppressions(profileId)
  );
  const result = writeFn();
  // Re-read suppressions after the write too: our satisfiers never touch the bus, but a
  // future satisfier that does must still diff against the post-write suppression state so
  // it can't announce a finding it just dismissed.
  const after = scope(
    snapshot(profileId, todayISO),
    getFindingSuppressions(profileId)
  );
  return { result, cleared: clearedFindings(before, after) };
}

// Compose a single closure toast line from the cleared findings — or null when nothing
// cleared (the common case must stay silent). Pure + unit-tested.
//
// `overrides` maps a dedupeKey PREFIX to a bespoke, VERBATIM sentence for a multi-step
// satisfier whose flip means something other than "the whole job is done": the fitness
// retest finding is BATTERY-level, so "cleared: Fitness check due" after one grip test
// would be premature — the fitness satisfier passes "Fitness check refreshed — retest
// clock restarts today", worded as what the flip actually means (#1305 multi-step rule).
// A finding with no override uses its title behind "That cleared: …". Multiple distinct
// clears collapse to one "Cleared N items: …" line.
export function formatClosureToast(
  cleared: readonly Finding[],
  overrides: Record<string, string> = {}
): string | null {
  if (cleared.length === 0) return null;
  const labels: { text: string; verbatim: boolean }[] = [];
  const seen = new Set<string>();
  for (const f of cleared) {
    const ov = Object.entries(overrides).find(([p]) =>
      f.dedupeKey.startsWith(p)
    );
    const text = ov ? ov[1] : f.title;
    if (seen.has(text)) continue; // battery-level flip → one line
    seen.add(text);
    labels.push({ text, verbatim: !!ov });
  }
  if (labels.length === 1) {
    return labels[0].verbatim
      ? labels[0].text
      : `That cleared: ${labels[0].text}`;
  }
  return `Cleared ${labels.length} items: ${labels.map((l) => l.text).join(", ")}`;
}
