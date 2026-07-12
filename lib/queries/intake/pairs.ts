// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Supplement pairings (take-together / keep-apart).
import { db } from "../../db";
import type { SupplementPair } from "../../types";

// "Take together" / "keep apart" pairs, with both supplement names joined in.
export function getSupplementPairs(profileId: number): SupplementPair[] {
  return db
    .prepare(
      `SELECT p.*, a.name AS a_name, b.name AS b_name
       FROM intake_item_pairs p
       JOIN intake_items a ON a.id = p.a_id
       JOIN intake_items b ON b.id = p.b_id
       WHERE a.profile_id = ?
       ORDER BY p.id`
    )
    .all(profileId) as SupplementPair[];
}
