// Allergy manifestation write core (issue #1405) — the IMPURE half of
// lib/allergy-reactions. AUTH-BLIND and profileId-first (#319): no lib/auth import,
// the calling Server Action is the only auth boundary.
//
// This module is the SINGLE writer of `allergy_reactions`, which is what makes the
// cached-first-row invariant safe: `allergies.reaction` / `.severity` stay a
// denormalized copy of manifestation 0 because exactly one function maintains both
// sides, in one IMMEDIATE transaction.

import { db, writeTx } from "./db";
import type { AllergyManifestation } from "./allergy-reactions";

// Trim + drop blanks + cap the list. A blank manifestation is not a reaction, and an
// unbounded list is a paste accident, not a clinical record.
const MAX_REACTIONS = 12;

export function sanitizeAllergyReactions(
  raw: readonly { manifestation: string; severity?: string | null }[]
): AllergyManifestation[] {
  const out: AllergyManifestation[] = [];
  for (const r of raw) {
    const manifestation = (r.manifestation ?? "").trim().slice(0, 200);
    if (!manifestation) continue;
    out.push({
      manifestation,
      severity: (r.severity ?? "").trim().slice(0, 80) || null,
    });
    if (out.length >= MAX_REACTIONS) break;
  }
  return out;
}

// Replace an allergy's full manifestation list and re-sync the parent's cached
// first manifestation. Returns false when the id isn't this profile's allergy
// (nothing written) — a typed refusal the caller renders, never a silent no-op that
// reads as success.
//
// Replace-not-merge is deliberate: the edit form posts the complete list the user is
// looking at, so a removed row must actually disappear. The child rows are re-minted
// with fresh ids; nothing references an allergy_reactions row by id.
export function setAllergyReactions(
  profileId: number,
  allergyId: number,
  reactions: readonly { manifestation: string; severity?: string | null }[]
): boolean {
  const clean = sanitizeAllergyReactions(reactions);
  return writeTx((): boolean => {
    const owned = db
      .prepare("SELECT id FROM allergies WHERE id = ? AND profile_id = ?")
      .get(allergyId, profileId) as { id: number } | undefined;
    if (!owned) return false;

    // Child table: scoped through its parent (no profile_id of its own), and the
    // parent ownership was just proven above.
    db.prepare("DELETE FROM allergy_reactions WHERE allergy_id = ?").run(
      allergyId
    );
    const ins = db.prepare(
      `INSERT INTO allergy_reactions (allergy_id, manifestation, severity, position)
       VALUES (?, ?, ?, ?)`
    );
    clean.forEach((r, i) => ins.run(allergyId, r.manifestation, r.severity, i));

    // Re-sync the denormalized cache the legacy readers select (see
    // lib/allergy-reactions for why those columns stayed). An empty list clears it.
    const first = clean[0] ?? null;
    db.prepare(
      `UPDATE allergies SET reaction = ?, severity = ?
        WHERE id = ? AND profile_id = ?`
    ).run(
      first?.manifestation ?? null,
      first?.severity ?? null,
      allergyId,
      profileId
    );
    return true;
  });
}
