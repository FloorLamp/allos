// Which canonical biomarker spellings this database has SUPERSEDED — the pure half
// of the #2306 reconciliation.
//
// THE DEFECT. buildCanonicalIndex fills its index from the whole vocabulary first
// and only then lays down the alias routes, dropping any route whose key a real
// entry already claimed. That precedence is right in itself ("a real entry always
// wins a key collision" is what stops an alias hijacking a distinct analyte) — but
// an ai-COINED row counts as a real entry. So:
//
//   1. a document spells an analyte its own way;
//   2. the same import registers that spelling as an `ai` row in canonical_biomarkers;
//   3. someone adds the CANONICAL_ALIASES route for it;
//   4. the route is dead on arrival — step 2 already claimed its key.
//
// Since importing the spelling is HOW you discover the alias is needed, every alias
// added in response to a real document was inert on the database that motivated it.
// The seed/ai promotion pass in boot-tasks never healed it: it promotes an ai row to
// `seed` when the name matches a dataset entry, and has no rule for a row whose name
// is an alias SOURCE.
//
// THE TWO SHAPES, one question. A vocabulary row is superseded when the vocabulary
// itself would resolve its key to a DIFFERENT spelling:
//
//   • SHADOWED — another entry already wins the key ("Hyaline Casts, Urine" beside
//     the curated "Casts, Hyaline, Urine"; both normalize to one key, seeds sort
//     first, so the curated entry is the winner). snapCanonicalName already resolves
//     this one; what never healed is the STORED rows written before the curated entry
//     existed, which keep the losing spelling forever.
//   • BLOCKED — the row wins its own key, but an alias route wants that key for
//     somewhere else ("Occult Blood, Urine" → "Blood, Urine"). This is the #2306
//     defect proper; the route only becomes live once the row is gone.
//
// Only `source = 'ai'` rows are ever superseded — a curated row is untouchable — and
// the target must be present in the vocabulary, which is the same guarantee
// buildCanonicalIndex already makes.
//
// Pure: no DB, no clock. lib/canonical-alias-merge-db.ts executes what this decides.

import {
  canonicalAliasRoutes,
  canonicalEntryIndex,
  normalizeCanonicalKey,
} from "./canonical-name";

export interface CanonicalVocabularyRow {
  name: string;
  source: string | null;
}

// One spelling retiring onto another. `from` and `to` always differ
// case-insensitively — a pure case variant is not a fork (every SQL grouping over
// biomarker names is NOCASE or lowercased), so re-spelling one would be churn.
export interface CanonicalMerge {
  from: string;
  to: string;
}

function isRename(from: string, to: string): boolean {
  return from.trim().toLowerCase() !== to.trim().toLowerCase();
}

// The ai-coined vocabulary rows this vocabulary has superseded, each paired with the
// spelling that supersedes it. Pass the rows in the SAME order the app reads them
// (getCanonicalVocabulary: seeded names before ai-coined ones) — that order is what
// decides which spelling wins a shared key.
//
// A merge whose target is itself being retired is DROPPED rather than followed: the
// pass is idempotent and runs on every boot, so the next run resolves the remainder
// one hop at a time instead of this function chasing a cycle.
export function supersededVocabularyRows(
  rows: readonly CanonicalVocabularyRow[]
): CanonicalMerge[] {
  const names = rows.map((r) => r.name);
  const entries = canonicalEntryIndex(names);
  const routes = canonicalAliasRoutes(names);
  const merges: CanonicalMerge[] = [];
  for (const row of rows) {
    if (row.source !== "ai") continue;
    const key = normalizeCanonicalKey(row.name);
    if (!key) continue;
    const winner = entries.get(key);
    // SHADOWED: another entry owns this key. BLOCKED: this row owns the key but an
    // alias route wants it elsewhere. Anything else is a row in good standing.
    const target = winner !== row.name ? winner : routes.get(key);
    if (!target || !isRename(row.name, target)) continue;
    merges.push({ from: row.name, to: target });
  }
  const retiring = new Set(merges.map((m) => m.from.toLowerCase()));
  return merges.filter((m) => !retiring.has(m.to.toLowerCase()));
}

// The stored canonical names that no longer spell their own analyte the way the
// (post-deletion) vocabulary does — i.e. what a FRESH import of the same name would
// store instead. This is the retroactive half: it re-points readings written before
// the curated entry or the alias route existed, and it is the same `snapCanonicalName`
// question the import path asks, asked of rows already on disk.
//
// The contract is deliberately exactly `snapCanonicalName` and nothing more: it makes
// STORAGE say what every read path already CONCLUDES, since canonicalResolver
// (lib/canonical-resolve.ts) snaps a stored name through this same index on the flag
// reconcile and the derived-series gather. It does NOT reproduce the import path's
// unit-aware arbitration (unitAwareCanonical, #918), which distrusts a snap whose
// entry unit contradicts the reading's and prefers the same-analyte sibling. That is a
// DISCOVERY-time refinement layered on the model's own output; canonicalResolver has
// no unit awareness either, so applying half of it here would make storage disagree
// with the read path rather than agree with it. A reading whose unit contradicts its
// resolved entry is the #918 residual-mismatch signal's business, not this pass's.
export function supersededStoredNames(
  storedNames: readonly string[],
  index: ReadonlyMap<string, string>
): CanonicalMerge[] {
  const merges: CanonicalMerge[] = [];
  const seen = new Set<string>();
  for (const stored of storedNames) {
    const name = stored.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const target = index.get(normalizeCanonicalKey(name));
    if (!target || !isRename(name, target)) continue;
    merges.push({ from: name, to: target });
  }
  return merges;
}

// ---- Protocol outcome keys -------------------------------------------------
//
// `protocols.outcome_keys` is a JSON array of namespaced metric ids, and a biomarker
// outcome is stored as the literal `biomarker:<canonical name>` (lib/protocol-metrics
// parses it, lib/protocol-outcome-picker mints it, and getProtocolWindowsForOutcome
// matches the whole string EXACTLY). So a canonical rename that skipped this column
// would silently unlink every protocol whose outcome was the renamed analyte.
//
// Returns the rewritten JSON, or null when nothing in this row referenced `from`
// (so the caller can skip the UPDATE). Order-preserving, and a rewrite that collides
// with a key the row ALREADY carries collapses onto it rather than duplicating.
const BIOMARKER_OUTCOME_PREFIX = "biomarker:";

export function rewriteBiomarkerOutcomeKeys(
  outcomeKeysJson: string,
  from: string,
  to: string
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcomeKeysJson);
  } catch {
    return null; // a corrupt column is somebody else's problem, never this pass's
  }
  if (!Array.isArray(parsed)) return null;
  const target = `${BIOMARKER_OUTCOME_PREFIX}${to}`;
  let changed = false;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed) {
    if (typeof raw !== "string") continue;
    const isMatch =
      raw.startsWith(BIOMARKER_OUTCOME_PREFIX) &&
      raw.slice(BIOMARKER_OUTCOME_PREFIX.length).trim().toLowerCase() ===
        from.trim().toLowerCase();
    const next = isMatch ? target : raw;
    if (isMatch) changed = true;
    // The target was already selected — collapse onto it, never duplicate. Only a
    // MATCH counts as a change here, so a row that merely repeats a key it already
    // had is left alone rather than rewritten by this pass.
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return changed ? JSON.stringify(out) : null;
}
