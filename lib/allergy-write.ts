// Allergy manifestation write core (issue #1405) — the IMPURE half of
// lib/allergy-reactions. AUTH-BLIND and profileId-first (#319): no lib/auth import,
// the calling Server Action is the only auth boundary.
//
// This module is the SINGLE writer of `allergy_reactions`, which is what makes the
// cached-first-row invariant safe: `allergies.reaction` / `.severity` stay a
// denormalized copy of manifestation 0 because exactly one function maintains both
// sides, in one IMMEDIATE transaction.

// THE WRITE CORE TAKES THE ID A WRITE GATE RETURNED: `profileId` on setAllergyReactions is
// lib/auth's WriteAuthorizedProfileId, which only the gates mint, so an action that never
// gated holds nothing it takes (#5348). The import is type-only — erased at build — so this
// module still runs auth-blind and app/(app)/records/problems/allergies/actions.ts still
// owns the gate, on both of its call sites (the create's own requireWriteAccess and the
// multi-view edit's gateItemProfile).
//
// What the brand buys is stated narrowly on purpose. `tsc` refuses a plain number at a call
// site — the ordinary accident — and eslint.config.mjs's WRITE_BRAND_CAST refuses production
// code the `as WriteAuthorizedProfileId` forge, across every production module (#5852,
// #5864); a test tier is deliberately left free to cast, the same allowance RPE_BRAND_CAST
// makes. Those are the accidents it catches; it does not make the brand unforgeable, and the
// residual is not a list anyone has closed (#5892, #5914). So "calls a branded core" is
// EVIDENCE of a gate, not PROOF of one — lib/__tests__/actions-write-access.test.ts's
// step-aside rests on that reading.

import type { WriteAuthorizedProfileId } from "./auth";
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
  profileId: WriteAuthorizedProfileId,
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
