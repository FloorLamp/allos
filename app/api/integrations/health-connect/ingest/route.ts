import { revalidatePath } from "next/cache";
import { db, writeTx } from "@/lib/db";
import { getTimezone } from "@/lib/settings";
import { log } from "@/lib/log";
import { reconcileFlags, addCanonicalNames } from "@/lib/queries";
import {
  resolveHealthConnectProfile,
  recordUnmatchedHealthConnectPush,
  recordSync,
  recordSyncEvent,
} from "@/lib/integrations/connections";
import {
  summarizeSplit,
  foldCounts,
  dateWindow,
  type UpsertCounts,
} from "@/lib/integrations/sync-log";
import {
  HEALTH_CONNECT_ID,
  parseHealthConnectPayload,
  type ParsedPayload,
} from "@/lib/integrations/health-connect";
import {
  upsertActivities,
  upsertHrMinutes,
  upsertMetricSamples,
  upsertVitals,
  upsertBodyMetrics,
  type IngestCounts,
} from "@/lib/integrations/normalize";
import { queueTempRedFlagDispatch } from "@/lib/notifications/temp-red-flag";
import { checkRateLimit } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/request-body";
import { writeRawPayload } from "@/lib/integrations/raw-log";
import { countPayloadRecords, MAX_INGEST_RECORDS } from "@/lib/ingest-bounds";
import { serializeHealthConnectSyncDetails } from "@/lib/integrations/sync-details";

// A rolling-48h phone export batch is small (a few days of samples/activities as
// JSON); 2MB is comfortably above any legitimate payload, so a larger body is
// almost certainly abuse — reject it before buffering the whole request.
const MAX_INGEST_BYTES = 2 * 1024 * 1024;

// Per-token fixed-window rate limit. A phone exporter pushes every few minutes, so
// 60 requests / 5 min is generous for legitimate use while capping a runaway or
// hostile client hammering this write path.
const INGEST_RATE_LIMIT = 60;
const INGEST_RATE_WINDOW_MS = 5 * 60 * 1000;

// Push-ingest endpoint for Google Health Connect. An Android exporter app (e.g.
// Health Connect Webhook) POSTs the device's recent Health Connect records here,
// authenticated with the bearer token from the Integrations page. Idempotent: the
// exporter resends a rolling 48h window, and the upserts dedup on natural keys.
export const dynamic = "force-dynamic";

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

// The local-date span the parsed batch covered (for the debug event's window),
// taken across every normalized record type; hr-minute timestamps are trimmed to
// their date so the window stays a clean date range.
function payloadWindow(parsed: ParsedPayload): {
  start: string | null;
  end: string | null;
} {
  return dateWindow([
    ...parsed.bodyMetrics.map((b) => b.date),
    ...parsed.samples.map((s) => s.date),
    ...parsed.activities.map((a) => a.date),
    ...parsed.vitals.map((v) => v.date),
    ...parsed.hrMinutes.map((h) => h.ts.slice(0, 10)),
  ]);
}

export async function POST(req: Request) {
  const token = bearer(req);

  // Rate-limit FIRST, before the token-resolution read — keyed on the presented
  // bearer (an absent token shares a single bucket). This throttles invalid-token
  // floods too, and caps over-budget callers before the parse and write.
  const rl = checkRateLimit(`health-connect:${token}`, {
    limit: INGEST_RATE_LIMIT,
    windowMs: INGEST_RATE_WINDOW_MS,
  });
  if (!rl.ok) {
    return Response.json(
      { ok: false, error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  // The bearer token identifies WHICH profile is pushing: each family member's
  // phone carries its own profile's token. Resolve it to a profile id (or reject).
  const INGEST_PROFILE_ID = resolveHealthConnectProfile(token);
  if (INGEST_PROFILE_ID === null) {
    // A presented-but-unmatched token with an existing HC connection is a rotated /
    // expired token — record a rate-limited failure so ingest doesn't stop silently
    // (#607). Best-effort: never throws, so it can't affect the 401 response.
    recordUnmatchedHealthConnectPush(token);
    return Response.json(
      {
        ok: false,
        error:
          "Unauthorized. Set the bearer token from Integrations → Google Health Connect.",
      },
      { status: 401 }
    );
  }

  // Fast path: reject early when Content-Length IS present and over the cap. The
  // profile is already resolved, so this rejection is attributable — record a
  // best-effort failure event (issue #604) so an over-size push shows up as a Data →
  // Review failure line instead of silently vanishing. The body carries `ok: false`
  // like every other response here (the two 413s were the only ones that omitted it,
  // breaking a client that switches on `body.ok`).
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_INGEST_BYTES) {
    recordSyncEvent(INGEST_PROFILE_ID, HEALTH_CONNECT_ID, {
      ok: false,
      error: `Payload too large (${contentLength} bytes > ${MAX_INGEST_BYTES}).`,
    });
    return Response.json(
      { ok: false, error: "payload too large" },
      { status: 413 }
    );
  }

  // Authoritative guard: byte-count the actual stream, aborting the moment
  // cumulative bytes exceed the cap. This defeats a chunked / absent / lying
  // Content-Length (serverActions.bodySizeLimit does NOT cover Route Handlers, so
  // this is the only real size guard here). Runs before the write transaction.
  const capped = await readBodyCapped(req.body, MAX_INGEST_BYTES);
  if ("overCap" in capped) {
    // Authoritative byte-cap rejection — the profile is resolved, so record an
    // attributable failure event (issue #604) and carry `ok: false` in the body, like
    // the bad-JSON and over-record-count rejections below do.
    recordSyncEvent(INGEST_PROFILE_ID, HEALTH_CONNECT_ID, {
      ok: false,
      error: `Payload too large (exceeded ${MAX_INGEST_BYTES} bytes).`,
    });
    return Response.json(
      { ok: false, error: "payload too large" },
      { status: 413 }
    );
  }

  // Capture the raw POST body for the admin-only raw viewer (issue #9), best-effort
  // — writeRawPayload never throws and returns null on any fs error, so it can't
  // affect ingest. The same ref is attached to whichever event this request records
  // (parse-failure, write-failure, or success).
  const rawRef = writeRawPayload(
    INGEST_PROFILE_ID,
    HEALTH_CONNECT_ID,
    capped.text
  );

  let body: unknown;
  try {
    body = JSON.parse(capped.text);
  } catch {
    // The profile IS known (token already resolved), so this failure is
    // attributable — record it best-effort for the debug panel, then reject.
    recordSyncEvent(INGEST_PROFILE_ID, HEALTH_CONNECT_ID, {
      ok: false,
      raw_ref: rawRef,
      error: "Invalid JSON body.",
    });
    return Response.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  // Record-count cap (issue #132): a <2MB payload can still carry tens of thousands
  // of records, all upserted in one synchronous transaction that blocks the single
  // better-sqlite3 connection for its duration. A legitimate rolling-48h batch is a
  // few thousand at most, so reject an over-cap payload before the write path with a
  // 400 and an attributable failure event (mirrors the JSON-body rejection above).
  const recordCount = countPayloadRecords(body);
  if (recordCount > MAX_INGEST_RECORDS) {
    const error = `Too many records in one payload (${recordCount} > ${MAX_INGEST_RECORDS}).`;
    recordSyncEvent(INGEST_PROFILE_ID, HEALTH_CONNECT_ID, {
      ok: false,
      raw_ref: rawRef,
      error,
    });
    return Response.json({ ok: false, error }, { status: 400 });
  }

  // Attribute each absolute timestamp to a local day/minute in the app-configured
  // timezone (production Docker runs UTC, so the process TZ can't be trusted).
  const parsed = parseHealthConnectPayload(
    body,
    getTimezone(INGEST_PROFILE_ID)
  );
  let counts: IngestCounts;
  let split: UpsertCounts;
  let vitalIds: number[] = [];
  // The flat per-type total (inserted + updated + unchanged) feeding the legacy
  // last_sync_summary / log.info, kept alongside the new split accounting.
  const total = (c: UpsertCounts) => c.inserted + c.updated + c.unchanged;
  try {
    const txResult = writeTx(
      (): { counts: IngestCounts; split: UpsertCounts } => {
        const bodyMetrics = upsertBodyMetrics(
          INGEST_PROFILE_ID,
          parsed.bodyMetrics,
          HEALTH_CONNECT_ID
        );
        const samples = upsertMetricSamples(
          INGEST_PROFILE_ID,
          parsed.samples,
          HEALTH_CONNECT_ID
        );
        const hrMinutes = upsertHrMinutes(
          INGEST_PROFILE_ID,
          parsed.hrMinutes,
          HEALTH_CONNECT_ID
        );
        const activities = upsertActivities(
          INGEST_PROFILE_ID,
          parsed.activities,
          HEALTH_CONNECT_ID
        );
        const vitals = upsertVitals(
          INGEST_PROFILE_ID,
          parsed.vitals,
          HEALTH_CONNECT_ID
        );
        vitalIds = vitals.ids;
        return {
          counts: {
            bodyMetrics: total(bodyMetrics),
            samples: total(samples),
            hrMinutes: total(hrMinutes),
            activities: total(activities),
            vitals: total(vitals.counts),
          },
          split: foldCounts([
            bodyMetrics,
            samples,
            hrMinutes,
            activities,
            vitals.counts,
          ]),
        };
      }
    );
    ({ counts, split } = txResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("health-connect ingest failed", { err: String(err) });
    // Best-effort failure event (never rethrows) — the window is known from the
    // parse that succeeded; counts stay null because the write didn't complete.
    const win = payloadWindow(parsed);
    recordSyncEvent(INGEST_PROFILE_ID, HEALTH_CONNECT_ID, {
      ok: false,
      windowStart: win.start,
      windowEnd: win.end,
      raw_ref: rawRef,
      error: message,
    });
    // The real error is logged + stored on the sync event server-side (above); the
    // response body stays GENERIC (issue #478) so raw internals — SQLite constraint
    // text, table names — never reach the bearer-token holder, matching every other
    // route's 500 shape.
    return Response.json(
      { ok: false, error: "internal error" },
      { status: 500 }
    );
  }

  // Post-commit reconcile (#131): register new canonical names and (re)compute
  // out-of-range flags for the imported vitals. This runs AFTER the transaction
  // committed, so a failure here must NOT be recorded as a failed sync — the batch
  // already landed. Scope its own try/catch to log-and-continue instead of folding
  // into the failure event above (which previously mislabelled a committed batch as
  // ok:false when this threw).
  if (vitalIds.length) {
    try {
      addCanonicalNames(parsed.vitals.map((v) => v.canonical));
      reconcileFlags(INGEST_PROFILE_ID, vitalIds);
    } catch (err) {
      log.error("health-connect post-commit reconcile failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // Event-driven temperature red-flag push (#1025): a pushed reading that crosses
    // a cited line dispatches the co-caregiver nudge NOW (fire-and-forget,
    // quiet-hours exempt like redose) instead of waiting for the next tick. The
    // shared orchestrator re-derives the finding from the OPEN episode's LATEST
    // reading — so a rolling-window re-push of an older reading, or a batch with no
    // open episode, sends nothing — and the per-finding marker + suppression bus own
    // dedup. The cheap pre-check inside the helper keeps ordinary batches free of
    // notification work; the hottest reading in the batch is the trigger candidate.
    const batchTemps = parsed.vitals
      .filter((v) => v.canonical === "Body Temperature")
      .map((v) => v.value_num);
    if (batchTemps.length) {
      queueTempRedFlagDispatch(INGEST_PROFILE_ID, Math.max(...batchTemps));
    }
  }

  const summary = { ...counts, skipped: parsed.skipped };
  recordSync(INGEST_PROFILE_ID, HEALTH_CONNECT_ID, summary);
  // Best-effort debug event: one row per POST with the data window + the real
  // insert/update/unchanged split (written = inserted + updated + unchanged, the
  // rows the idempotent upserts touched; skipped = rows received but parser-dropped).
  // recordSyncEvent never throws, so it can't affect ingest.
  const tally = summarizeSplit(split, parsed.skipped);
  const win = payloadWindow(parsed);
  recordSyncEvent(INGEST_PROFILE_ID, HEALTH_CONNECT_ID, {
    ok: true,
    windowStart: win.start,
    windowEnd: win.end,
    received: tally.received,
    written: tally.inserted + tally.updated + tally.unchanged,
    inserted: tally.inserted,
    updated: tally.updated,
    unchanged: tally.unchanged,
    suppressed: tally.suppressed,
    edited: tally.edited,
    skipped: tally.skipped,
    details: serializeHealthConnectSyncDetails(parsed.details),
    raw_ref: rawRef,
  });
  log.info("health-connect ingest", summary);

  // Refresh the views the imported data feeds into. (`/medical` and `/import`
  // both folded into the `/data` hub — repointed here so the import view
  // revalidates.)
  for (const p of [
    "/",
    "/trends",
    "/training",
    "/results",
    "/data",
    "/integrations/health-connect",
  ]) {
    revalidatePath(p);
  }

  return Response.json({ ok: true, counts: summary });
}
