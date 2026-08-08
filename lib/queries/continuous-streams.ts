// The DB half of the quiet-stream detector (#2146). The decision is pure and lives in
// lib/integrations/quiet-stream.ts; nothing here re-derives it. This module only
// (a) binds a reader to each declared stream table, (b) asks the three questions the
// predicate needs, and (c) maps the verdicts onto the shared attention shape.
//
// ── The reader binding, and why the registry does not build SQL ──────────────
//
// `ContinuousStreamTable` is a closed union and STREAM_READERS below has one entry per
// member — the same DATA-HERE / RUNNABLE-THERE split the `pull` facet uses
// (lib/integrations/pull-runners.ts). The registry therefore stays importable from the
// pure tier and from client components, and no SQL is ever assembled from a
// declaration. Adding a stream on a new table is a new entry here; the compiler names
// the file when the union grows.
//
// ── THE THREE TIMESTAMP CONVENTIONS, joined on purpose ───────────────────────
//
// #2146 constraint 6 is the whole reason this module reads times the way it does. The
// predicate joins across columns that have not all carried the same convention, and
// misreading one of them as another is the #2096 failure class — the bug that still
// LOOKS right in every query.
//
// So nothing here parses a stored stamp by hand. Every read goes through
// `eventInstant` (lib/row-instants.ts), which resolves the column against its DECLARED
// meaning in lib/time-columns.ts — semantic, grain and convention — and normalizes to
// one canonical instant. What that buys, concretely:
//
//   • `hr_minutes.ts` — declared `event` / `instant` / canonical. It USED to be a
//     profile-local wall clock and migration 164 converted it; a reader that had
//     hard-coded the old convention (as lib/notifications/wear-reminder.ts did, fixed
//     in this change) silently stopped resolving anything at all, because
//     `zonedWallIsoToUtc` REFUSES a stamp carrying `Z`. Going through the declaration
//     means the next conversion moves this reader with it.
//   • `integration_sync_events.at` — declared `event` / `instant` / canonical since
//     migration 163, with pre-163 rows still on SQLite's bare shape. `toUtcInstant`
//     inside the resolver reads both, so a legacy row is compared correctly instead of
//     sorting as a different day.
//   • the DAY the expected-active gate counts — a third question, not a third column.
//     A day is profile-local (#94) and is never a substring of a UTC instant, so the
//     gate bounds each day with `localDayRange` rather than slicing `ts`; migration
//     164 dropped the `substr(ts,1,10)` index for exactly this reason. #2097's own
//     side of the shared gate reads `metric_samples` wake-days the same way.
//
// And nothing is compared as a STRING. Both instants are converted to epoch
// milliseconds before any arithmetic, so a bare legacy stamp and a `Z` stamp in one
// column cannot answer wrong while the query still looks right.
//
// ── Two cheap reads per stream ───────────────────────────────────────────────
//
// `MAX(ts)` on the stream (one indexed seek on the primary key) and `MAX(at)` over the
// provider's ok events (one indexed seek). "Was there an ok sync inside the gap
// window" is exactly `maxOkSyncAt > lastStreamAt`, which needs no window predicate and
// no second query. The expected-active gate adds one bounded EXISTS per day of the
// declared window (three, today).

import { db, today as profileToday } from "@/lib/db";
import { cache } from "@/lib/request-cache";
import { getTimezone } from "@/lib/settings";
import { getDisplayFormatPrefs } from "@/lib/settings/display";
import { instantNow } from "@/lib/clock";
import { parseUtcSql, shiftDateStr, zonedDateParts } from "@/lib/date";
import { localDayRange } from "@/lib/local-day-window";
import { eventInstant } from "@/lib/row-instants";
import { formatClockValue } from "@/lib/format-date";
import { isStreamActive } from "@/lib/stream-activity";
import type { ContinuousStreamTable, IntegrationId } from "@/lib/types";
import type { AttentionIntegration } from "@/lib/attention";
import { integrationDetailHref } from "@/lib/hrefs";
import {
  quietStreamDedupeKey,
  quietStreamDetail,
  quietStreams,
  quietStreamTitle,
  type QuietStream,
  type QuietStreamCandidate,
} from "@/lib/integrations/quiet-stream";
import { quietReportableStreams } from "@/lib/integrations/continuous-streams";
import { getConnection } from "@/lib/integrations/connections";
import { getIntegrationAttention } from "./integrations";

// ── Per-table readers ────────────────────────────────────────────────────────

interface StreamReader {
  /** The newest row's EVENT instant for this profile + source, canonical, or null. */
  latestAt(profileId: number, source: string): string | null;
  /** Does this profile have any row from `source` inside the local day `day`? */
  deliveredOnDay(
    profileId: number,
    source: string,
    tz: string,
    day: string
  ): boolean;
}

const STREAM_READERS: Record<ContinuousStreamTable, StreamReader> = {
  hr_minutes: {
    latestAt(profileId, source) {
      const row = db
        .prepare(
          `SELECT MAX(ts) AS ts FROM hr_minutes
            WHERE profile_id = ? AND source = ?`
        )
        .get(profileId, source) as { ts: string | null } | undefined;
      // `ts` is declared, not assumed: eventInstant reads TIME_COLUMNS.hr_minutes and
      // normalizes whatever convention that column is on today.
      const at = eventInstant("hr_minutes", { ts: row?.ts ?? null });
      return at.known ? at.at : null;
    },
    deliveredOnDay(profileId, source, tz, day) {
      // The local day as a half-open UTC range over the canonical column — the house
      // rule since migration 164 dropped the substr(ts,1,10) index precisely because a
      // substring of a UTC instant is a UTC day, which is not the reader's day.
      const { startUtc, endUtc } = localDayRange(tz, day);
      const row = db
        .prepare(
          `SELECT 1 AS hit FROM hr_minutes
            WHERE profile_id = ? AND source = ? AND ts >= ? AND ts < ?
            LIMIT 1`
        )
        .get(profileId, source, startUtc, endUtc) as
        { hit: number } | undefined;
      return row != null;
    },
  },
};

/**
 * The newest instant on a declared stream, canonical UTC, or null.
 *
 * Exported because #2161's bedtime wear reminder asks the identical question about the
 * identical stream and must not ask it a second way — that is how one of the two ends
 * up on a retired timestamp convention while the other moves on.
 */
export function latestStreamInstant(
  profileId: number,
  table: ContinuousStreamTable,
  source: string
): string | null {
  return STREAM_READERS[table].latestAt(profileId, source);
}

/**
 * The newest SUCCESSFUL sync instant for a provider, canonical UTC, or null.
 *
 * One seek, and it answers the syncs-continued question outright: at least one ok sync
 * landed inside the gap window `(lastStreamAt, now]` exactly when this value is
 * greater than `lastStreamAt`.
 */
export function latestOkSyncInstant(
  profileId: number,
  provider: string
): string | null {
  const row = db
    .prepare(
      `SELECT MAX(at) AS at FROM integration_sync_events
        WHERE profile_id = ? AND provider = ? AND ok = 1`
    )
    .get(profileId, provider) as { at: string | null } | undefined;
  const at = eventInstant("integration_sync_events", { at: row?.at ?? null });
  return at.known ? at.at : null;
}

/**
 * Epoch ms for an already-normalized canonical instant, or null.
 *
 * Every comparison in this module goes through here rather than comparing the strings:
 * two of the three columns joined below have carried more than one serialization in
 * their lifetime, and a lexical comparison between a bare stamp and a `Z` stamp is
 * wrong in a way that leaves the query looking correct (#2096).
 */
function ms(at: string | null): number | null {
  return parseUtcSql(at)?.getTime() ?? null;
}

// ── The gather ───────────────────────────────────────────────────────────────

/**
 * Every quiet stream for this profile, at most one per provider.
 *
 * Read-time and stateless: it writes nothing, sets no marker, and a backfilled batch
 * clears the row on the next render because it moves `MAX(ts)` forward.
 *
 * Memoized per REQUEST only. There is deliberately no `tickCached` twin: this signal
 * never reaches a send (#2146 constraint 4), so no tick has a reason to ask for it.
 */
export const getQuietStreams = cache(function getQuietStreams(
  profileId: number
): QuietStream[] {
  const streams = quietReportableStreams();
  if (streams.length === 0) return [];

  const nowMs = Date.parse(instantNow());
  const tz = getTimezone(profileId);
  const todayStr = profileToday(profileId);
  // The providers already carrying a `failing` / `stale` row (#1685) — the memoized
  // escalation list every other surface reads, so "healthy" here means exactly what
  // Data → Review's Needs-attention card means. Resolved at most once per gather and
  // only when a declared stream is actually reached — a profile with no connected
  // stream provider pays nothing for it.
  let flagged: Set<string | null> | null = null;
  const alreadyFlagged = (provider: string): boolean => {
    flagged ??= new Set(getIntegrationAttention(profileId).map((r) => r.id));
    return flagged.has(provider);
  };

  const candidates: QuietStreamCandidate[] = [];
  for (const { provider, stream } of streams) {
    // A stream is only expected while the connection is live. A disconnected or
    // needs-reauth provider is not delivering anything and is not being asked to.
    if (getConnection(profileId, provider)?.status !== "connected") continue;

    const quiet = stream.quiet;
    if (!quiet) continue;

    const sinceAt = latestStreamInstant(profileId, stream.table, provider);
    const sinceMs = ms(sinceAt);
    const minutesSinceStream =
      sinceMs == null ? null : Math.floor((nowMs - sinceMs) / 60_000);

    // Everything below is only asked once there is a gap worth asking about. A live
    // stream is the overwhelmingly common case and it costs exactly the one MAX(ts)
    // seek above; the expected-active window (one seek per declared day) and the ok-
    // sync seek are paid only when the answer could be "quiet".
    const overTolerance =
      minutesSinceStream != null && minutesSinceStream > quiet.dipToleranceMin;

    // The shared #2097/#2146 expected-active gate, over the stream's DECLARED window.
    const deliveredDays: string[] = [];
    if (overTolerance) {
      const reader = STREAM_READERS[stream.table];
      for (let back = 1; back <= stream.expectedActive.windowDays; back++) {
        const day = shiftDateStr(todayStr, -back);
        if (reader.deliveredOnDay(profileId, provider, tz, day))
          deliveredDays.push(day);
      }
    }

    const okSyncMs = overTolerance
      ? ms(latestOkSyncInstant(profileId, provider))
      : null;
    candidates.push({
      provider,
      streamId: stream.id,
      // Resolved unconditionally so the pure predicate's guard ORDER holds exactly as
      // written (yield first, then the data). It is free on the surface that renders
      // this: Data → Review already reads the same escalation list for its
      // Needs-attention card, and `getIntegrationAttention` is request-memoized.
      providerHealthy: !alreadyFlagged(provider),
      expectedActive: isStreamActive(
        deliveredDays,
        todayStr,
        stream.expectedActive.windowDays,
        stream.expectedActive.minDays
      ),
      minutesSinceStream,
      // STRICTLY after the last row: a sync landing exactly at that instant is the one
      // that DELIVERED it, not evidence that syncing continued without it.
      syncedDuringGap:
        sinceMs != null && okSyncMs != null && okSyncMs > sinceMs,
      toleranceMin: quiet.dipToleranceMin,
      sinceAt,
      sinceLocalHhmm: sinceAt != null ? localHhmm(tz, sinceAt) : null,
      today: todayStr,
    });
  }
  return quietStreams(candidates);
});

/** A canonical instant as the profile-local `HH:MM` the copy names. */
function localHhmm(tz: string, at: string): string | null {
  const d = parseUtcSql(at);
  return d ? zonedDateParts(tz, d).hhmm : null;
}

/**
 * The quiet-stream rows in the shared attention shape (#2146: `AttentionIntegration`
 * gains a third `kind` beside `failing` and `stale`).
 *
 * DELIBERATELY NOT FOLDED INTO `getIntegrationAttention`. That list is the ESCALATION
 * set: the profile-menu badge counts it, the dashboard's non-hideable hero renders it,
 * and — decisively — the morning digest builds a banded section from it. Quiet-stream
 * is coaching tier, classes 2/3 only, so putting it in that list would have made it a
 * SEND, which #2146 constraint 4 forbids under the contact-consent rule. The separate
 * entry point is what makes "renders, never sends" a property of the wiring rather
 * than a comment; `buildAttentionModel` and the digest additionally filter the kind,
 * so a future caller cannot re-introduce the leak by accident.
 *
 * `loginId` supplies the clock preference the "since" time is rendered in — the row is
 * read by a person, and a person's clock convention is login-scoped.
 */
export function getQuietStreamAttention(
  profileId: number,
  loginId: number
): AttentionIntegration[] {
  const prefs = getDisplayFormatPrefs(loginId);
  const byProvider = new Map(
    quietReportableStreams().map((s) => [`${s.provider}:${s.stream.id}`, s])
  );
  const rows: AttentionIntegration[] = [];
  for (const q of getQuietStreams(profileId)) {
    const declared = byProvider.get(`${q.provider}:${q.streamId}`);
    if (!declared?.stream.quiet) continue;
    rows.push({
      id: q.provider,
      provider: declared.providerName,
      detail: quietStreamDetail({
        streamLabel: declared.stream.label,
        sinceClock: formatClockValue(q.sinceLocalHhmm, prefs.timeFormat),
        quietForMin: q.quietForMin,
        prompt: declared.stream.quiet.prompt,
      }),
      kind: "quiet-stream",
    });
  }
  return rows;
}

/**
 * The rendered row's ingredients for Data → Review — the attention shape plus the
 * title, the deep link, and the date-scoped key. A thin projection so the component
 * builds no copy of its own.
 */
export interface QuietStreamRow extends AttentionIntegration {
  title: string;
  href: ReturnType<typeof integrationDetailHref>;
  key: string;
}

export function getQuietStreamRows(
  profileId: number,
  loginId: number
): QuietStreamRow[] {
  const quiet = new Map(getQuietStreams(profileId).map((q) => [q.provider, q]));
  const labels = new Map(
    quietReportableStreams().map((s) => [
      `${s.provider}:${s.stream.id}`,
      s.stream.label,
    ])
  );
  return getQuietStreamAttention(profileId, loginId).flatMap((row) => {
    const q = quiet.get(row.id as IntegrationId);
    if (!q) return [];
    return [
      {
        ...row,
        title: quietStreamTitle(
          row.provider,
          labels.get(`${q.provider}:${q.streamId}`) ?? "stream"
        ),
        href: integrationDetailHref(q.provider),
        key: quietStreamDedupeKey(q),
      },
    ];
  });
}
