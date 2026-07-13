// Standalone backup entrypoint (issue #25). Decouples the backup schedule from
// the notify sidecar so an operator who removed notify can still cron backups:
//
//   npm run backup            # SCHEDULE-GATED tick — takes a snapshot only when
//                             # the configured backup hour is due and none was
//                             # taken today; also runs the weekly live-DB
//                             # integrity check. Safe to cron hourly.
//   npm run backup -- now     # FORCE — take (and verify) a snapshot immediately,
//                             # ignoring the schedule (for manual/ad-hoc backups).
//
// Exit codes: 0 = ok (ran or nothing due); 1 = a backup/verification failure.

import "./load-env";

import {
  performBackup,
  runScheduledBackup,
  runLiveIntegrityCheck,
} from "../lib/backup";
import { createLogger } from "../lib/log";

const log = createLogger("backup-cli");

async function main() {
  const arg = process.argv[2]?.toLowerCase();

  if (arg === "now" || arg === "force") {
    // Ad-hoc: still run the (self-gated) weekly live check, then force a snapshot.
    runLiveIntegrityCheck();
    const { name, size, verification } = performBackup();
    if (verification.integrity !== "ok") {
      log.error("forced backup failed integrity check", {
        name,
        detail: verification.detail,
      });
      process.exit(1);
    }
    log.info("forced backup complete", { name, size });
    process.exit(0);
  }

  if (arg && arg !== "tick") {
    console.error("Usage: npm run backup [-- now]");
    process.exit(2);
  }

  const r = runScheduledBackup();
  if (r.ran) log.info("scheduled backup", { failed: r.failed, error: r.error });
  else log.info("no backup due this tick");
  process.exit(r.failed ? 1 : 0);
}

main().catch((e) => {
  log.error("backup failed", { err: e instanceof Error ? e : String(e) });
  process.exit(1);
});
