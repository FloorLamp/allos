// Backfill for `body_metrics.weight_at` / `body_fat_at` / `resting_hr_at` (#3950,
// owner-ruled 2026-08-29: "backfill from the source archive while it still exists").
//
// THE ARCHIVE IS THE ONLY PLACE THE ANSWER SURVIVES. Health Connect states a separate
// instant per measure; the parser has carried them in memory since #3551 and the
// columns to hold them only exist as of this change, so every row written before it
// has the right weight and no idea when it was taken. The raw push bodies persisted
// for the admin viewer (lib/integrations/raw-log.ts, newest-N per profile+source under
// data/integration-payloads) still contain those instants — until retention prunes
// them, which is the window the ruling is racing.
//
// SAFE BY REFUSAL, not by cleverness. A stored day row may have been written by a
// LATER push than the one being read here — body fat and resting HR are stored as day
// AVERAGES, so a partial window's average is a genuinely different number. So a
// measure is filled ONLY when its stored value is still exactly the value this payload
// produced, and only when the instant column is NULL. When the two disagree we decline
// and count it: a per-measure instant that describes a different reading is worse than
// no instant at all, and NULL already means "the source stated none".
//
// Server-only: it reads the archive from disk.

import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { parseHealthConnectPayload } from "./health-connect";
import { HEALTH_CONNECT_ID } from "./health-connect";
import { RAW_PAYLOAD_ROOT } from "./raw-log";

export interface InstantBackfillTally {
  // Archive files read and successfully parsed.
  payloads: number;
  // Files skipped: not JSON (the 512 KB cap truncates a large payload mid-string) or
  // unreadable. Counted, never fatal — a debug artifact was never a contract.
  unreadable: number;
  // Per-measure column fills.
  filled: number;
  // Measures the archive could date but whose stored value has since moved on.
  declined: number;
}

// The three measures, each with the column holding its value, the column holding its
// instant, and the parsed field that states it. Named together so a fourth measure
// cannot be added to one without the others — the same pairing
// lib/integrations/ingest-timezone-reconcile.ts makes for the same reason.
const MEASURES = [
  { value: "weight_kg", at: "weight_at", from: "weight_at" },
  { value: "body_fat_pct", at: "body_fat_at", from: "body_fat_at" },
  { value: "resting_hr", at: "resting_hr_at", from: "resting_hr_at" },
] as const;

// Profile directories in the archive, as numeric ids. A non-numeric entry is not ours.
function archivedProfileIds(): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(RAW_PAYLOAD_ROOT);
  } catch {
    return []; // no archive at all — nothing to backfill, not an error
  }
  return entries
    .map((e) => Number(e))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// This profile's archived Health Connect payloads, newest file first so the most
// recent statement of a day is the one that gets to fill it.
function archivedPayloads(profileId: number): string[] {
  const dir = path.join(RAW_PAYLOAD_ROOT, String(profileId));
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter(
        (f) => f.startsWith(`${HEALTH_CONNECT_ID}-`) && f.endsWith(".json")
      );
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const abs = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(abs).mtimeMs;
      } catch {
        // unstattable sorts oldest; it is still read
      }
      return { abs, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => e.abs);
}

/**
 * Fill NULL per-measure instants on Health Connect body-metric rows from the archived
 * push bodies. Idempotent: a filled column is never revisited, and a payload read twice
 * fills nothing the second time. `timezoneFor` resolves each profile's zone — injected
 * rather than imported so this stays callable outside a request scope (and from tests).
 */
export function backfillBodyMetricInstants(
  db: Database.Database,
  timezoneFor: (profileId: number) => string
): InstantBackfillTally {
  const tally: InstantBackfillTally = {
    payloads: 0,
    unreadable: 0,
    filled: 0,
    declined: 0,
  };
  // One prepared UPDATE per measure. The WHERE clause carries the whole safety rule:
  // right row, instant still absent, and the value this payload produced still standing.
  const updates = MEASURES.map((m) =>
    db.prepare(
      `UPDATE body_metrics SET ${m.at} = ?
        WHERE profile_id = ? AND date = ? AND source = ?
          AND ${m.at} IS NULL AND ${m.value} IS NOT NULL AND ${m.value} = ?`
    )
  );

  for (const profileId of archivedProfileIds()) {
    const tz = timezoneFor(profileId);
    for (const abs of archivedPayloads(profileId)) {
      let parsed;
      try {
        parsed = parseHealthConnectPayload(
          JSON.parse(fs.readFileSync(abs, "utf8")),
          tz
        );
      } catch {
        tally.unreadable++;
        continue;
      }
      tally.payloads++;
      for (const row of parsed.bodyMetrics) {
        MEASURES.forEach((m, i) => {
          const at = row[m.from];
          const value = row[m.value];
          if (at == null || value == null) return;
          const info = updates[i].run(
            at,
            profileId,
            row.date,
            HEALTH_CONNECT_ID,
            value
          );
          if (info.changes > 0) tally.filled += info.changes;
          else tally.declined++;
        });
      }
    }
  }
  return tally;
}
