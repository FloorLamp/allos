import { writeTx } from "@/lib/db";
import { createLogger } from "@/lib/log";
import type { IntegrationId } from "@/lib/types";
import {
  markConnectionNeedsReauth,
  recordSync,
  recordSyncEvent,
  recordSyncRows,
} from "./connections";
import { isAuthRefreshFailure } from "./auth-failure";
import {
  dateWindow,
  emptyCounts,
  foldCounts,
  summarizeSplit,
  type ProvenanceEntry,
  type UpsertCounts,
} from "./sync-log";
import { truncatedSyncDetails } from "./sync-details";
import { writeRawPayload } from "./raw-log";
import { queuePostWorkoutForFreshImports } from "@/lib/notifications/post-workout-imports";
import {
  upsertActivities,
  upsertActivityRoutes,
  upsertBodyMetrics,
  upsertMetricSamples,
  upsertVitals,
  type NormActivity,
  type NormActivityRoute,
  type NormBodyMetric,
  type NormMetricSample,
  type NormVital,
} from "./normalize";
import {
  replaceActivityLaps,
  replaceSegmentEfforts,
  upsertCyclingTelemetry,
  type NormActivityLap,
  type NormCyclingTelemetry,
  type NormSegmentEffort,
} from "./cycling-telemetry";
import { shouldAdvanceCursor, type CursorPolicy } from "./pull-window";

// THE pull-sync runner (#2040). One implementation of everything a scheduled pull
// does either side of the source's own API calls:
//
//   credentials → gather → upsert in one tx → post-commit hooks → cursor → accounting
//
// oura-sync.ts, withings-sync.ts and strava-sync.ts used to carry three copies of
// that, identical down to the comments ("Mirrors oura-sync.ts", "Mirrors
// strava-sync.ts") — three places to keep the sync invariants true, and a fourth
// waiting for Garmin. They now supply only a `PullSpec`: how to authorize, how to
// page their endpoints, how to map rows, and what to call their counts.
//
// The invariants (docs/internals/integrations-sync.md) are asserted HERE, once:
// dedupe happens in the keyed upserts, a manually edited row is never overwritten
// (isEditLocked, inside those upserts), every run records inserted/updated/unchanged,
// and a run the source cut short keeps its cursor and carries the durable
// `truncated` marker Review reads.
//
// It must NOT touch any Next.js request-scoped API (revalidatePath): it runs from
// both the Server Action and the hourly notify tick. Callers revalidate.

const log = createLogger("pull-sync");

// The rows one run gathered, already normalized. A source supplies only the kinds
// it actually produces; the rest are absent and their upserts are skipped.
export interface PullBatch {
  activities?: NormActivity[];
  bodyMetrics?: NormBodyMetric[];
  vitals?: NormVital[];
  samples?: NormMetricSample[];
  // A side artifact of the activity it belongs to (Strava's polyline), resolved by
  // external_id inside the same transaction. Deliberately NOT folded into the run's
  // tally — it is not its own record.
  routes?: NormActivityRoute[];
  // Optional rich cycling artifacts gathered with an activity. These resolve their
  // parent through the activity external id, so the shared runner persists them in
  // the SAME transaction, after the activity upsert. Replacement parents are
  // explicit: a source may successfully fetch an empty lap/segment list, while a
  // transient detail failure must preserve the prior children.
  cyclingTelemetry?: NormCyclingTelemetry[];
  activityLaps?: NormActivityLap[];
  segmentEfforts?: NormSegmentEffort[];
  cyclingArtifactParents?: string[];
}

// A successful gather.
export interface PullGather<TCursor extends string | number> {
  batch: PullBatch;
  // The raw source JSON this run fetched, for the admin-only raw viewer (#9).
  raw: unknown[];
  // Rows the source returned that mapped to nothing.
  skipped: number;
  // The source cut the run short (page/detail cap, or a rate limit). Data remains
  // upstream; the cursor policy below decides what that means.
  truncated: boolean;
  // The newest cursor value this run reached. The runner commits it per the spec's
  // policy; null/absent means the run learned nothing newer.
  nextCursor?: TCursor | null;
}

// A gather that could not complete. `status` is the failing HTTP status when there
// was one — a DEFINITIVE auth failure (a revoked personal access token) flips the
// connection to needs_reauth so the tick stops retrying forever (#326). A source
// that resolves credentials through its own refresh path leaves it unset, because
// that path already owns the reauth transition.
export interface PullFailure {
  error: string;
  status?: number;
}

export type PullOutcome<TCursor extends string | number> =
  PullGather<TCursor> | PullFailure;

function isFailure<T extends string | number>(
  o: PullOutcome<T>
): o is PullFailure {
  return "error" in o;
}

// Per-kind row totals (inserted + updated + unchanged) — what a source names its
// counts after. Kinds it does not produce are 0.
export interface PullTotals {
  activities: number;
  bodyMetrics: number;
  vitals: number;
  samples: number;
  skipped: number;
}

// What the transaction wrote, for the post-commit hooks.
export interface PullCommit {
  activities: UpsertCounts;
  bodyMetrics: UpsertCounts;
  vitals: UpsertCounts;
  samples: UpsertCounts;
  // Row ids of the vitals written this run — the canonical-name/flag reconcile needs
  // them, and it must run AFTER the commit.
  vitalIds: number[];
}

export interface PullSpec<
  TToken,
  TCursor extends string | number,
  TCounts extends Record<string, number>,
> {
  id: IntegrationId;
  // Resolve the credential. `null` means NOT CONNECTED — not a sync attempt, so
  // nothing is logged. A THROW is a real failure (a refresh that couldn't complete)
  // and is recorded as a failed sync event.
  authorize(profileId: number): Promise<TToken | null> | TToken | null;
  cursor: {
    read(profileId: number): TCursor;
    write(profileId: number, value: TCursor): void;
    policy: CursorPolicy;
  };
  // The genuinely per-source part: endpoints, `next_token` vs `offset/more` vs
  // `page` pagination, and row mapping.
  gather(
    profileId: number,
    token: TToken,
    cursor: TCursor
  ): Promise<PullOutcome<TCursor>>;
  // The source's own count vocabulary for `last_sync_summary` and its typed result
  // ("workouts" for Oura, "activities" for Strava, …).
  summarize(totals: PullTotals): TCounts;
  // Work that must happen after the transaction COMMITTED — a reconcile, a merge.
  // A failure here must not fail the sync: the batch already landed. Log and carry on.
  // Gets the gathered batch too, since a reconcile generally needs the MAPPED rows
  // (their canonical names) and not only the ids the transaction returned.
  afterCommit?(profileId: number, commit: PullCommit, batch: PullBatch): void;
  // What the source ran out of, for the truncation log line.
  truncationReason?: string;
}

// Run one source's scheduled pull. Returns its own count summary (plus
// `truncated: true` when the run was cut short), or `{ error }` for a graceful
// failure — never throws for an ordinary source/network problem.
export async function runPullSync<
  TToken,
  TCursor extends string | number,
  TCounts extends Record<string, number>,
>(
  profileId: number,
  spec: PullSpec<TToken, TCursor, TCounts>
): Promise<(TCounts & { truncated?: true }) | { error: string }> {
  let token: TToken | null;
  try {
    token = await spec.authorize(profileId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSyncEvent(profileId, spec.id, { ok: false, error: message });
    return { error: message };
  }
  // Not a sync attempt (no credentials / not connected yet) — nothing to log.
  if (token == null) return { error: "not connected" };

  const cursor = spec.cursor.read(profileId);
  const outcome = await spec.gather(profileId, token, cursor);
  if (isFailure(outcome)) {
    if (outcome.status != null && isAuthRefreshFailure(outcome.status)) {
      markConnectionNeedsReauth(profileId, spec.id);
    }
    recordSyncEvent(profileId, spec.id, { ok: false, error: outcome.error });
    return { error: outcome.error };
  }

  const { batch, raw, skipped, truncated } = outcome;
  const activities = batch.activities ?? [];
  const bodyMetrics = batch.bodyMetrics ?? [];
  const vitals = batch.vitals ?? [];
  const samples = batch.samples ?? [];
  const routes = batch.routes ?? [];
  // The window this run's rows cover — stamped on the event either way, so a failed
  // write still says what it was trying to write.
  const win = () =>
    dateWindow([
      ...activities.map((a) => a.date),
      ...bodyMetrics.map((b) => b.date),
      ...vitals.map((v) => v.date),
      ...samples.map((s) => s.date),
    ]);

  const commit: PullCommit = {
    activities: emptyCounts(),
    bodyMetrics: emptyCounts(),
    vitals: emptyCounts(),
    samples: emptyCounts(),
    vitalIds: [],
  };
  // Per-row provenance (#1333): the inserted/updated rows this run wrote, linked to
  // the success event below.
  const provenance: ProvenanceEntry[] = [];
  try {
    writeTx(() => {
      if (batch.activities) {
        commit.activities = upsertActivities(
          profileId,
          activities,
          spec.id,
          provenance
        );
      }
      if (batch.bodyMetrics) {
        commit.bodyMetrics = upsertBodyMetrics(
          profileId,
          bodyMetrics,
          spec.id,
          provenance
        );
      }
      if (batch.vitals) {
        const v = upsertVitals(profileId, vitals, spec.id, provenance);
        commit.vitals = v.counts;
        commit.vitalIds = v.ids;
      }
      if (batch.samples) {
        commit.samples = upsertMetricSamples(
          profileId,
          samples,
          spec.id,
          provenance
        );
      }
      // Routes resolve their parent activity by external_id, so this must run after
      // upsertActivities (same tx). Idempotent; not folded into the tally.
      if (batch.routes) upsertActivityRoutes(profileId, routes, spec.id);
      if (batch.cyclingTelemetry) {
        upsertCyclingTelemetry(profileId, batch.cyclingTelemetry, spec.id);
      }
      if (batch.cyclingArtifactParents) {
        replaceActivityLaps(
          profileId,
          batch.activityLaps ?? [],
          spec.id,
          batch.cyclingArtifactParents
        );
        replaceSegmentEfforts(
          profileId,
          batch.segmentEfforts ?? [],
          spec.id,
          batch.cyclingArtifactParents
        );
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const w = win();
    recordSyncEvent(profileId, spec.id, {
      ok: false,
      windowStart: w.start,
      windowEnd: w.end,
      error: message,
    });
    return { error: message };
  }

  // The no-finish fallback for imports (#1154 §B2): a just-synced session dated today
  // gets the delayed post-workout dose dispatch armed, so its doses aren't
  // bucket-slot-dependent. Only when the run actually INSERTED an activity — a pure
  // re-scan of known rows arms nothing, and a source that writes no activities at
  // all never reaches it.
  if (commit.activities.inserted > 0)
    queuePostWorkoutForFreshImports(profileId);
  if (spec.afterCommit) {
    try {
      spec.afterCommit(profileId, commit, batch);
    } catch (err) {
      log.error("post-commit hook failed", {
        sourceId: spec.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The cursor decision, from the one pure rule (pull-window.shouldAdvanceCursor).
  if (
    shouldAdvanceCursor(
      spec.cursor.policy,
      truncated,
      outcome.nextCursor,
      cursor
    )
  ) {
    spec.cursor.write(profileId, outcome.nextCursor as TCursor);
  }

  const total = (c: UpsertCounts) => c.inserted + c.updated + c.unchanged;
  const counts = spec.summarize({
    activities: total(commit.activities),
    bodyMetrics: total(commit.bodyMetrics),
    vitals: total(commit.vitals),
    samples: total(commit.samples),
    skipped,
  });

  // The legacy flat `last_sync_summary`, in the source's own count vocabulary.
  recordSync(profileId, spec.id, { ...counts, truncated: truncated ? 1 : 0 });
  {
    const w = win();
    const tally = summarizeSplit(
      foldCounts([
        commit.activities,
        commit.bodyMetrics,
        commit.vitals,
        commit.samples,
      ]),
      skipped
    );
    // Best-effort raw capture (never throws): the JSON we fetched this run.
    const rawRef = writeRawPayload(profileId, spec.id, JSON.stringify(raw));
    const eventId = recordSyncEvent(profileId, spec.id, {
      ok: true,
      windowStart: w.start,
      windowEnd: w.end,
      received: tally.received,
      written: tally.inserted + tally.updated + tally.unchanged,
      inserted: tally.inserted,
      updated: tally.updated,
      unchanged: tally.unchanged,
      suppressed: tally.suppressed,
      edited: tally.edited,
      skipped: tally.skipped,
      // A run the source cut short (page cap / 429) is NOT a clean success: the
      // cursor was deliberately not advanced and data is still upstream, so the event
      // carries a durable `truncated` marker + its Review line (#1614). Ordinary
      // complete runs write no details at all.
      details: truncated ? truncatedSyncDetails() : null,
      raw_ref: rawRef,
    });
    recordSyncRows(eventId, provenance);
  }
  if (truncated) {
    log.info(
      `${spec.id} sync truncated (${spec.truncationReason ?? "page cap / rate limit"})`,
      { ...counts }
    );
  }
  return truncated ? { ...counts, truncated: true } : { ...counts };
}
