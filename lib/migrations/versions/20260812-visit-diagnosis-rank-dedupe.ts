import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Heal the visit-diagnosis summaries already on disk (issue #2589).
//
// `encounters.diagnoses` is a "; "-joined summary of a visit's diagnosis display names.
// Until the import seam started normalizing them, a source system that bakes the
// diagnosis RANK into the display name produced one finding listed twice:
//
//   "Encounter for genetic carrier testing; Encounter for genetic carrier testing - Primary"
//
// which the Visits card renders as two full-width chips. Re-importing the document heals
// its own encounters, but nobody should have to re-import their history to stop being
// told they were diagnosed with the same thing twice — so this rewrites the stored
// summaries once.
//
// ── Why this file COPIES the rule instead of importing it ─────────────────────────────
//
// The obvious thing is to call lib/visit-diagnoses.ts, and an earlier draft of this
// migration did. It is wrong, and the reason is worth stating because it reads like
// duplication:
//
// A shipped migration must keep converting exactly as it did the day it ran, and
// migration-immutability.test.ts enforces that by hashing `versions/*.ts`. That hash
// does not reach THROUGH an import. Edit the shared rule's word list or its logic and
// this migration's behaviour changes while its sha256 sits unchanged in manifest.json —
// the immutability guarantee silently stops covering the half that does the work. That
// is not hypothetical here: the first version of this pass shipped a rule that stripped
// "- Primary"/"- Secondary" on sight, which destroys real clinical content (primary vs
// secondary hyperparathyroidism are different diseases). Narrowing the live rule
// afterwards must NOT retroactively change what this migration is recorded as having
// done — an install that already ran it needs a new, separately-hashed corrective
// migration, and that is only possible if this file's behaviour is pinned to this file.
//
// Migration 166 set the precedent, copying OVERNIGHT_MIN rather than importing it for
// this reason. The general rule in lib/visit-diagnoses.ts's header — "a second copy is
// how the two drift" — is about the three LIVE seams, which must agree with each other
// forever. A frozen migration is the deliberate exception: it must agree with the past.
//
// ── What the frozen rule does ─────────────────────────────────────────────────────────
//
// A trailing "- Primary"/"- Secondary" is read as a RANK only against evidence inside the
// same summary: the stripped base name must also appear as an entry carrying no qualifier
// at all, and must not be wearing a second, different qualifier elsewhere in the summary.
// With no such twin the suffix is part of the diagnosis and the entry is untouched, so
// "Hyperparathyroidism - Primary; Hyperparathyroidism - Secondary" and a lone
// "Adrenal insufficiency - Secondary" pass through byte-identical. Order is preserved
// except where a collapse actually happened.
//
// No CHILD_LINKS declaration: this migration deletes no row and moves no id — it only
// rewrites a text column in place. A delete-guard probe on a pass that cannot delete is
// the #2444 defect, not protection against it. Idempotent: normalizing an
// already-normalized summary returns it unchanged, so re-running writes nothing.

const FROZEN_RANKS = ["primary", "secondary"] as const;
type FrozenRank = (typeof FROZEN_RANKS)[number];

const FROZEN_RANK_SUFFIX_RE = new RegExp(
  `\\s+-\\s+(${FROZEN_RANKS.join("|")})\\s*$`,
  "i"
);

function frozenStrength(rank: FrozenRank | null): number {
  if (rank === "primary") return 2;
  if (rank === "secondary") return 1;
  return 0;
}

function frozenCandidate(raw: string): {
  name: string;
  rank: FrozenRank | null;
} {
  const trimmed = raw.trim();
  const m = FROZEN_RANK_SUFFIX_RE.exec(trimmed);
  if (!m) return { name: trimmed, rank: null };
  const name = trimmed.slice(0, m.index).trim();
  if (!name) return { name: trimmed, rank: null };
  return { name, rank: m[1].toLowerCase() as FrozenRank };
}

export function normalizeSummary(summary: string | null): string | null {
  const raw = (summary ?? "")
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed = raw.map((full) => ({
    full,
    candidate: frozenCandidate(full),
  }));

  const plainKeys = new Set(
    parsed
      .filter((p) => p.candidate.rank === null)
      .map((p) => p.candidate.name.toLowerCase())
  );
  const qualifiersByBase = new Map<string, Set<FrozenRank>>();
  for (const p of parsed) {
    if (p.candidate.rank === null) continue;
    const key = p.candidate.name.toLowerCase();
    const seen = qualifiersByBase.get(key) ?? new Set<FrozenRank>();
    seen.add(p.candidate.rank);
    qualifiersByBase.set(key, seen);
  }

  const byKey = new Map<string, { name: string; rank: FrozenRank | null }>();
  const order: string[] = [];
  for (const p of parsed) {
    const base = p.candidate.name.toLowerCase();
    const evidenced =
      p.candidate.rank !== null &&
      plainKeys.has(base) &&
      (qualifiersByBase.get(base)?.size ?? 0) < 2;
    const entry = evidenced
      ? { name: p.candidate.name, rank: p.candidate.rank }
      : { name: p.full, rank: null };
    const key = entry.name.toLowerCase();
    const prev = byKey.get(key);
    if (prev == null) {
      byKey.set(key, entry);
      order.push(key);
      continue;
    }
    if (frozenStrength(entry.rank) > frozenStrength(prev.rank)) {
      byKey.set(key, { name: prev.name, rank: entry.rank });
    }
  }

  const entries = order.map(
    (k) => byKey.get(k) as { name: string; rank: FrozenRank | null }
  );
  const joined = [
    ...entries.filter((e) => e.rank === "primary"),
    ...entries.filter((e) => e.rank !== "primary"),
  ]
    .map((e) => e.name)
    .join("; ");
  return joined === "" ? null : joined;
}

export function up(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, diagnoses FROM encounters
        WHERE diagnoses IS NOT NULL AND TRIM(diagnoses) != ''`
    )
    .all() as { id: number; diagnoses: string }[];
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE encounters SET diagnoses = ? WHERE id = ?`);
  for (const r of rows) {
    const next = normalizeSummary(r.diagnoses);
    if (next !== r.diagnoses) update.run(next, r.id);
  }
}

export const migration: Migration = {
  name: "20260812-visit-diagnosis-rank-dedupe",
  up,
};
