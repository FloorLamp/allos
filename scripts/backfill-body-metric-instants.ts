// Operator entrypoint for the one-time per-measure body-metric instant backfill
// (#3950, owner-ruled 2026-08-29):
//
//   npm run body-metrics:backfill-instants
//
// Fills `weight_at` / `body_fat_at` / `resting_hr_at` on Health Connect body-metric
// rows written before those columns existed, by re-reading the archived push bodies
// under data/integration-payloads. RUN IT SOON: that archive keeps only the newest
// payloads per source, so the answers it holds are pruned as the exporter keeps
// pushing. Idempotent and safe to re-run — it only ever fills a NULL, and only when
// the stored measure still matches the value the payload produced.
//
// Days the exporter's rolling window still covers do not need this: the ordinary
// re-send now carries their instants through the normal upsert.
//
// Exit code 0 always: declining to date a row whose value has moved on is the
// designed outcome, not a failure.

import "./load-env";

import { db } from "../lib/db";
import { backfillBodyMetricInstants } from "../lib/integrations/body-metric-instant-backfill";
import { getTimezone } from "../lib/settings/display";
import { createLogger } from "../lib/log";

const log = createLogger("body-metric-instant-backfill-cli");

const tally = backfillBodyMetricInstants(db, (profileId) =>
  getTimezone(profileId)
);
log.info("body-metric instant backfill complete", { ...tally });
