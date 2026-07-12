// Part of the lib/queries/intake barrel (#319 — same #126 treatment training
// got). The profile-scoping guard walks all of lib/, so these split modules stay
// covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
// Stored AI insight reads.
import { db } from "../../db";
import type { Insight } from "../../types";

// ---- Insights ----
export function getInsight(
  profileId: number,
  date: string
): Insight | undefined {
  return db
    .prepare("SELECT * FROM insights WHERE profile_id = ? AND date = ?")
    .get(profileId, date) as Insight | undefined;
}

export function getInsights(profileId: number, limit = 30): Insight[] {
  return db
    .prepare(
      "SELECT * FROM insights WHERE profile_id = ? ORDER BY date DESC LIMIT ?"
    )
    .all(profileId, limit) as Insight[];
}
