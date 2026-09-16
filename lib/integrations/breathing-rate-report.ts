import { recordSyncEvent } from "./connections";
import type { BreathingRateAdoption } from "@/lib/breathing-rate-db";

// WHAT THE #5409 ADOPTION DECLINED, WHERE A PERSON CAN SEE IT.
//
// IT LIVES IN ITS OWN MODULE FOR ONE CONCRETE REASON, and it is not tidiness:
// `lib/breathing-rate-db.ts` is imported by a MIGRATION, and a migration is loaded
// through `lib/migrations/versions/index.ts` while `lib/db.ts` is still initialising.
// `recordSyncEvent` reaches `lib/db`, so putting this beside the adoption closed a
// cycle - migration -> breathing-rate-db -> connections -> db -> runMigrations ->
// versions/index - that survives only if the app happens to import `lib/db` first.
// It does in the running app and in one test tier; it did NOT in the other, and 792
// suites failed on `Cannot access … before initialization`. The type import below is
// erased, so the edge this file adds points only one way.

/**
 * Append one `integration_sync_events` row naming what the adoption could not move.
 *
 * WHY A SYNC EVENT AND NOT A LOG LINE. Server logs are the one surface a user of this
 * app never reads, and these declines are about THEIR data: a night that stays in the
 * vitals fold because a reference on it has nowhere to go, or a reading outside the
 * plausible envelope. Data → Review renders `integration_sync_events` per source,
 * where the rest of "what this push did and did not do" already lives (`suppressed`,
 * `edited`, `superseded`).
 *
 * `ok: true` and `skipped`, deliberately: nothing FAILED. The push wrote what it
 * could, the declined nights are intact where they were, and every later push
 * re-derives the same answer - so this is a disclosure, not an error, and it must not
 * put a red badge on a sync that worked. A run with nothing to decline writes no row.
 *
 * Best-effort like every other `recordSyncEvent` caller: it can neither break nor
 * meaningfully slow the ingest it observes.
 */
export function reportBreathingRateDeclines(
  profileId: number,
  sourceId: string,
  adoption: BreathingRateAdoption
): void {
  if (adoption.declined.length === 0) return;
  const nights = adoption.declined.reduce((n, d) => n + d.nights, 0);
  recordSyncEvent(profileId, sourceId, {
    ok: true,
    skipped: nights,
    details: `breathing rate: ${nights} night(s) left in medical records — ${adoption.declined
      .map((d) => `${d.held_by} (${d.nights})`)
      .join(", ")}`,
  });
}
