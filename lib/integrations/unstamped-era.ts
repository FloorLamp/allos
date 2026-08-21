import { getSetting, setSetting } from "@/lib/settings";
import {
  UNSTAMPED_ERA_AT_KEY,
  UNSTAMPED_ERA_MAX_ID_KEY,
  type UnstampedEra,
} from "@/lib/metric-window-overlap";

// THE TWO FACTS THAT LICENSE DELETING A NULL-STAMPED ROW (#3424).
//
// `metric_samples.pushed_at` is NULL on every row written before
// `20260821-hc-overlap-supersede` added it. The supersede used to read that NULL as
// "older than every stamp"; it means UNKNOWN, and on deploy day EVERY row in the store
// is NULL — the correct ones included. Reading it as old let a byte-identical replay of
// a pre-switch push delete the correct re-anchored row, leaving the day reading LOW and
// beyond #3439's reach. See lib/metric-window-overlap.ts for the full account.
//
// So the migration writes down, once, the two things that turn "unknown" back into
// something checkable, and this module is the only place that reads or writes them:
//
//   * WHEN the column started being written. A push stamped after that instant happened
//     after every row that was already in the table.
//   * WHAT WAS ALREADY THERE — `MAX(metric_samples.id)` at that instant. `id` is
//     `INTEGER PRIMARY KEY AUTOINCREMENT` (migration 083), so it is monotonic and never
//     reused: `id <= lastUnstampedId` cannot become true for a row written later.
//
// They live in the app-global `settings` key/value table, which already holds migration
// flags, rather than in a column of their own: they are two scalars for the whole
// instance, written once and never moved.
//
// A CLOSING WINDOW, ON PURPOSE. Once #3439 has replayed the rule over stored history,
// there are no unstamped Health Connect day buckets left for this path to act on and it
// goes dormant on its own. Nothing needs to remove it, and removing it early would
// re-open the pre-PR double count on any day the rolling window no longer reaches.

/**
 * Record the era, ONCE. Later calls are no-ops.
 *
 * Idempotent by first-write-wins rather than by last: the marker describes the moment
 * the column landed, and a migration re-run (a restore, a half-applied database, a
 * second boot) happens later than that. Moving it forward would re-classify every row
 * written in between as pre-existing, which is exactly the confusion it exists to end.
 */
export function recordUnstampedEra(startedAt: string, maxId: number): void {
  if (getSetting(UNSTAMPED_ERA_AT_KEY) !== undefined) return;
  setSetting(UNSTAMPED_ERA_AT_KEY, startedAt);
  setSetting(UNSTAMPED_ERA_MAX_ID_KEY, String(Math.max(0, Math.trunc(maxId))));
}

/**
 * The recorded era, or `null` when there is not a complete, readable one.
 *
 * NULL IS THE SAFE ANSWER and every unreadable state resolves to it: no marker, a
 * missing half, a value that is not a number. With no era, no NULL-stamped row is ever
 * superseded — the double count stays visible and repairable, which is the direction
 * this whole path fails in.
 */
export function readUnstampedEra(): UnstampedEra | null {
  const startedAt = getSetting(UNSTAMPED_ERA_AT_KEY);
  const rawId = getSetting(UNSTAMPED_ERA_MAX_ID_KEY);
  if (startedAt === undefined || rawId === undefined) return null;
  const lastUnstampedId = Number(rawId);
  if (!Number.isSafeInteger(lastUnstampedId) || lastUnstampedId < 0)
    return null;
  return { startedAt, lastUnstampedId };
}
