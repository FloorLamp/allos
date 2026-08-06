// Operator entrypoint for the one-time photo metadata backfill (#1844):
//
//   npm run photo:backfill
//
// Boot already runs this pass once per install (lib/migrations/boot-tasks.ts →
// runPhotoMetadataBackfill), marker-gated. This script runs it AGAIN on demand,
// ignoring the marker — for an operator who restored files from an older backup, or
// who wants to see the tally after a run that reported failures. It is safe: the pass
// is idempotent per FILE (a stored photo that already carries no metadata is skipped,
// never re-compressed), so a re-run over a clean corpus does nothing but read it.
//
// Exit codes: 0 = the pass completed (even with skips); 1 = at least one file could
// not be cleaned, which leaves those files exactly as they were.

import "./load-env";

import { db } from "../lib/db";
import { backfillPhotoMetadata } from "../lib/photo/metadata-backfill";
import { createLogger } from "../lib/log";

const log = createLogger("photo-backfill-cli");

async function main() {
  const tally = await backfillPhotoMetadata(db);
  log.info("photo metadata backfill complete", { ...tally });
  process.exit(tally.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log.error("photo metadata backfill failed", { err });
  process.exit(1);
});
