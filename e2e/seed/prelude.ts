// e2e seed fixtures — prelude domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import fs from "node:fs";
import path from "node:path";
import { now as clockNow } from "../../lib/clock";
import { db, writeTx } from "../../lib/db";
import { utcInstant, zonedDateParts, zonedWallTimeToUtc } from "../../lib/date";
import { setDeliveryFailure } from "../../lib/notifications/delivery-marker";
import { getTimezone, setInstanceTimezone } from "../../lib/settings";
import { pinnedTimezone } from "../pinned-timezone";

// Re-anchor the APP SEED's stated instants into the instance timezone this run
// just pinned (#2154).
//
// WHY THIS EXISTS. The template is seeded by two processes in order: scripts/
// seed.ts, then this file (e2e/global-setup.ts). The pin above happens in the
// SECOND one — so every `occurred_at` the app seed wrote resolved a profile-local
// wall clock ("the 09:00 reading") against the zone in force at THAT moment, which
// is UTC (no instance default yet, no per-profile override). Re-read afterwards in
// the pinned zone, that same instant denotes a different wall clock: a UTC+11 run
// turned the seeded 08:00 reading into a 19:00 one, which then outranked a reading
// a spec logged at 13:mm as the day's LATEST — silently breaking the temperature
// red-flag surface (#1019) with no fixture visibly at fault.
//
// The repair belongs HERE, beside the pin that invalidates them, and it preserves
// what the app seed actually meant: the row's own wall clock, re-anchored onto the
// row's own `date` in the new zone — so the pair invariant every writer enforces
// (a stated instant's profile-local date IS the row's date) still holds.
//
// Scoped to profiles with NO per-profile timezone: those DO resolve through the
// instance default and are affected; a profile carrying its own zone resolved
// correctly at seed time and must not be touched. scripts/seed.ts is left honest
// for dev/demo, where no pin happens and its values are already right.
function reanchorSeededInstants(zone: string): void {
  const rows = db
    .prepare(
      `SELECT r.id AS id, r.date AS date, r.occurred_at AS occurred_at
         FROM medical_records r
        WHERE r.occurred_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM profile_settings s
             WHERE s.profile_id = r.profile_id AND s.key = 'timezone'
          )`
    )
    .all() as { id: number; date: string; occurred_at: string }[];
  if (rows.length === 0) return;
  const update = db.prepare(
    `UPDATE medical_records SET occurred_at = ? WHERE id = ?`
  );
  let moved = 0;
  writeTx(() => {
    for (const row of rows) {
      const at = new Date(row.occurred_at);
      if (Number.isNaN(at.getTime())) continue;
      // The wall clock the app seed MEANT, read back in the zone it wrote under.
      const { hhmm } = zonedDateParts("UTC", at);
      const reanchored = zonedWallTimeToUtc(zone, row.date, hhmm);
      if (!reanchored) continue; // a wall time that doesn't exist in the new zone
      update.run(utcInstant(reanchored), row.id);
      moved++;
    }
  });
  console.log(
    `e2e: re-anchored ${moved} seeded medical_records instant(s) into ${zone}`
  );
}

// ── Instance timezone pin + delivery-failure / server-error log markers ──
export function seedPrelude(): void {
  // Pin the instance-default timezone so the frozen clock (#1103's run-start
  // ALLOS_TEST_NOW) reads 13:mm LOCAL — deterministic Midday — at every UTC start
  // hour; see e2e/pinned-timezone.ts for why the run-start freeze alone left
  // bucket-progression assertions (past-due doses) hour-dependent. Global-only on
  // purpose: every profile without an explicit per-profile timezone resolves to
  // the instance default at READ time (lib/settings getTimezone), including
  // profiles specs create at runtime. A fixture that DEPENDS on UTC wall-times
  // opts out per-profile below (the food-slot ranking profile). The demo server
  // seeds via scripts/seed.ts only and stays UTC — its specs are time-neutral.
  if (process.env.ALLOS_TEST_NOW) {
    const { zone } = pinnedTimezone(process.env.ALLOS_TEST_NOW);
    setInstanceTimezone(zone);
    console.log(`e2e: pinned instance timezone ${zone} (frozen local ~13:00)`);
    // The app seed ran BEFORE this pin, so its stated instants mean the wrong
    // wall clock now — see reanchorSeededInstants.
    reanchorSeededInstants(zone);
  }

  // A persisted notification-delivery failure (#131) so Settings → Notifications
  // surfaces the "Last notification delivery failed" marker for the e2e to assert.
  // Synthetic error text — no PHI. Written through the real marker write path (the
  // notify_lifecycle delivery-health row, #942) so the fixture can't drift from
  // what dispatch() records on a failed Telegram send.
  // The canonical second-resolution instant (#2233, migration 167) — the same
  // shape instantNow() binds on a real failed dispatch.
  writeTx(() =>
    setDeliveryFailure(
      "telegram",
      "Telegram API 401: Unauthorized (bot token revoked)",
      "2026-07-09T08:00:00Z"
    )
  );

  // A persisted unexpected server error (#596) so Settings → Errors has a row to
  // render for the admin-access e2e. Synthetic message — no PHI. Written straight
  // to the errors.jsonl the admin page reads (data/logs/errors.jsonl), so the test
  // doesn't need to provoke a real 500. Mirrors what recordErrorEvent appends.
  // WRITE, not append: unlike the DB, errors.jsonl isn't reset between e2e runs,
  // and a second appended copy of the same message would strict-mode-break the
  // spec's getByText assertion.
  {
    const errorLogPath = path.join(
      process.cwd(),
      "data",
      "logs",
      "errors.jsonl"
    );
    fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
    const seededErrorNow = clockNow();
    const event = {
      id: `${seededErrorNow.getTime()}-000000`,
      time: utcInstant(seededErrorNow),
      level: "error",
      scope: "e2e-seed",
      message: "Seeded server error for the admin errors surface",
      detail:
        "Error: synthetic failure\n    at seedEvents (e2e/seed-events.ts)",
      loginId: null,
      profileId: null,
    };
    fs.writeFileSync(errorLogPath, JSON.stringify(event) + "\n");
  }
}
