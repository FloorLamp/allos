import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

export function foodEventHighWater(): number {
  const db = new Database(workerDbPath(), { readonly: true });
  try {
    return (
      (
        db.prepare("SELECT MAX(id) AS id FROM food_log_events").get() as {
          id: number | null;
        }
      ).id ?? 0
    );
  } finally {
    db.close();
  }
}

/** Reverse only catalog-serving events written after this test's high-water mark. */
export function removeFoodEventsAfter(
  afterId: number,
  groups: readonly string[],
  profileId = 1
): void {
  if (groups.length === 0) return;
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const placeholders = groups.map(() => "?").join(", ");
    const events = db
      .prepare(
        `SELECT id, date, group_key
           FROM food_log_events
          WHERE profile_id = ? AND id > ?
            AND group_key IN (${placeholders})`
      )
      .all(profileId, afterId, ...groups) as Array<{
      id: number;
      date: string;
      group_key: string;
    }>;

    const remove = db.transaction(() => {
      const counts = new Map<string, number>();
      const dropEvent = db.prepare(
        "DELETE FROM food_log_events WHERE id = ? AND profile_id = ?"
      );
      for (const event of events) {
        dropEvent.run(event.id, profileId);
        const key = `${event.date}\0${event.group_key}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      const decrement = db.prepare(
        `UPDATE food_daily_totals SET servings = servings - ?
          WHERE profile_id = ? AND date = ? AND group_key = ? AND servings >= ?`
      );
      const dropEmpty = db.prepare(
        `DELETE FROM food_daily_totals
          WHERE profile_id = ? AND date = ? AND group_key = ? AND servings = 0`
      );
      for (const [key, count] of counts) {
        const [date, group] = key.split("\0");
        if (decrement.run(count, profileId, date, group, count).changes !== 1)
          throw new Error(
            `could not reverse ${count} ${group} serving(s) on ${date}`
          );
        dropEmpty.run(profileId, date, group);
      }
    });
    remove.immediate();
  } finally {
    db.close();
  }
}
