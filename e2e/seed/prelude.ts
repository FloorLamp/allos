// e2e seed fixtures — prelude domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import fs from "node:fs";
import path from "node:path";
import { writeTx } from "../../lib/db";
import { setDeliveryFailure } from "../../lib/notifications/delivery-marker";
import { getTimezone, setInstanceTimezone } from "../../lib/settings";
import { pinnedTimezone } from "../pinned-timezone";

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
    const event = {
      id: `${Date.now()}-000000`,
      time: new Date().toISOString(),
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
