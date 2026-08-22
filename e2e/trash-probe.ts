import Database from "better-sqlite3";
import { serializePayload } from "../lib/undo-delete";
import { frozenNow, workerDbPath } from "./worker-env";

// SPEC-OWNED TRASH CAPTURES (issue #3491).
//
// The shared seed puts NOTHING in `deleted_rows` — re-derived 2026-08-22 with a
// `git grep deleted_rows` over e2e/seed/ and e2e/seed-events.ts, which returns
// nothing — so Data → Trash renders its empty state under the fixture and there is
// no row for a probe to measure or a census to read. Every trash assertion in the
// suite therefore builds its own subject: e2e/trash.spec.ts does it through the UI
// (create an activity, delete it, walk away from the toast), which is right for a
// journey test and far too slow for a layout measurement that needs three rows of
// three different shapes.
//
// WHY NOT SEED IT INSTEAD, since that would serve every caller at once: because
// `e2e/trash.spec.ts`'s last test EMPTIES THE WHOLE TRASH. A seeded capture would be
// destroyed by it whenever the two land in the same worker, so a route that depended
// on one would be green or red by shard composition — the #3388 failure mode, and an
// especially bad one under an absence assertion, which an empty page flatters.
//
// So a caller plants what it needs inside its own test and sweeps it afterwards
// (#868 fixture ownership). The label prefix below is what makes the sweep exact:
// nothing else in the tree writes it, so a sweep can never take a sibling's capture
// or a real one.
//
// PROFILE 1 is the seeded admin's own profile — the same one every desktop-project
// spec browses as.

/** Every planted capture carries this in its non-PHI `label`, so the sweep is exact. */
export const TRASH_PROBE_LABEL_PREFIX = "probe kind";

export interface PlantedTrashCapture {
  /**
   * Appended to TRASH_PROBE_LABEL_PREFIX to form the `deleted_rows.label` — the
   * non-PHI kind descriptor the row's subtitle prints. The prefix is added here
   * rather than by the caller so a planted capture cannot escape the sweep.
   */
  labelSuffix: string;
  /** The payload root's title, or null for an UNTITLED capture. */
  title: string | null;
  /** The payload root's date (`YYYY-MM-DD`), or null. */
  date: string | null;
}

function withProbeDb<T>(fn: (db: Database.Database) => T): T {
  const handle = new Database(workerDbPath());
  try {
    handle.pragma("busy_timeout = 5000");
    return fn(handle);
  } finally {
    handle.close();
  }
}

/**
 * Plant one holding row per spec, newest first in the order given.
 *
 * The captures are `activity` kind because that is the registry kind whose root
 * carries BOTH a title and a date column — which is what lets one call produce a
 * titled capture and an untitled one, the two headline branches #3491 is about.
 * Omitting the title column is exactly how a real untitled capture arises (a body
 * metric's root is a date and some numbers).
 *
 * `deleted_at` is derived from the run's FROZEN instant, never the wall clock: the
 * app's `now()` is frozen for the whole run and the expiry sentence is computed
 * against it, so a wall-clock stamp would drift the "Expires in N days" copy.
 */
export function plantTrashCaptures(
  captures: readonly PlantedTrashCapture[]
): void {
  const deletedAt = frozenNow().toISOString().replace("T", " ").slice(0, 19);
  withProbeDb((db) => {
    const insert = db.prepare(
      `INSERT INTO deleted_rows (profile_id, kind, label, payload, deleted_at)
       VALUES (1, 'activity', ?, ?, ?)`
    );
    for (const c of captures) {
      const root: Record<string, unknown> = { id: 90001, profile_id: 1 };
      if (c.date) root.date = c.date;
      if (c.title) root.title = c.title;
      insert.run(
        `${TRASH_PROBE_LABEL_PREFIX} ${c.labelSuffix}`,
        serializePayload("activity", { activity: [root] }),
        deletedAt
      );
    }
  });
}

/** Remove every planted capture. Safe to call when none were planted. */
export function sweepTrashProbes(): void {
  withProbeDb((db) => {
    db.prepare(`DELETE FROM deleted_rows WHERE label LIKE ?`).run(
      `${TRASH_PROBE_LABEL_PREFIX}%`
    );
  });
}
