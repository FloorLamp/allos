// Stored daily coaching-insight reads. These are coaching summaries across health
// domains, not intake data; the coaching query barrel owns them.
import { db } from "../../db";
import type { DailyInsight } from "../../types";

export function getDailyInsight(
  profileId: number,
  date: string
): DailyInsight | undefined {
  return db
    .prepare("SELECT * FROM insights WHERE profile_id = ? AND date = ?")
    .get(profileId, date) as DailyInsight | undefined;
}

export function getDailyInsights(
  profileId: number,
  limit = 30
): DailyInsight[] {
  return db
    .prepare(
      "SELECT * FROM insights WHERE profile_id = ? ORDER BY date DESC LIMIT ?"
    )
    .all(profileId, limit) as DailyInsight[];
}
