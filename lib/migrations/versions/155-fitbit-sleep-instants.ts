import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 155 (issue #2096): reinterpret already-stored Fitbit Takeout sleep
// boundaries, which were persisted as ZONELESS WALL CLOCK, against the profile's
// timezone.
//
// Fitbit writes a sleep log's `startTime`/`endTime` as `2026-07-19T22:57:00.000` —
// what the device's clock said, with nothing about where that clock was — and the
// Takeout parser stored the string verbatim. Every read path then hands it to
// `new Date()`, which resolves an offset-less date-time in the PROCESS zone, so the
// instant a stored night denoted was a property of the container's `TZ` rather than
// of the data. Measured on one profile's 52 Takeout nights, the derived typical wake
// time moved from 05:57 to 01:55 between the profile's zone and `TZ=UTC` — and
// production is Docker, i.e. the wrong column ships.
//
// The parser fix (#2096) makes new imports write absolute instants. This migration is
// the other half, and it is NOT optional: `start_time` is the natural upsert key
// (profile_id, metric, source, origin, start_time), so a re-import after the parser
// fix would land under a NEW key and leave every wrong row beside its correction —
// one night stored twice, and the stale copy still feeding the source-election and
// wake-time reads. Converting in place means the re-import finds its own row and
// counts it `unchanged`.
//
// WHAT IS CONVERTED, and what is deliberately not:
//
//   • Only `source = 'fitbit-takeout'` and only the five sleep metrics. Every other
//     Takeout family already stored an absolute instant or a day label (see
//     localDate / dayLabelDate in the parser); this bug was specific to the one
//     parser that took no `tz`.
//   • Only a value that still LOOKS like a bare wall clock. Anything already carrying
//     `Z` or an offset is left alone, which is what makes a replay a no-op — the DB
//     test tier replays migrations over an at-rest database.
//   • NEVER an edit-locked row (`edited`, the #133 lock extended to metric_samples by
//     migration 115). A hand-corrected window is the user's statement about when they
//     slept, and rewriting it under them is precisely the overwrite the lock exists to
//     forbid. Such a row keeps its zoneless value, so a later re-import still skips it
//     for the same reason.
//
// Stage rows key on `<start>#<stage>` so the four stages of a night don't collide on
// the shared window; the discriminator is split off, converted, and re-attached, so a
// night's total and its stages stay on one instant.
//
// The tombstones move WITH the rows. `import_tombstones` suppresses the re-insert of
// a user-deleted sample by natural key, and that key embeds `start_time`. Left
// untouched, every deleted Takeout night would silently come back on the next import
// — the #508 resurrection, reintroduced by a fix. (Precedent: migration 083 rewrote
// the same keys when it changed this table's identity.)
//
// WHICH ZONE. The profile's current `profile_settings.timezone`, falling back to the
// instance default and then UTC — the same resolution order lib/timezone.resolveTimezone
// uses at runtime. This is an interpretation, not a recovery: the archive never
// recorded where the wrist was, so a profile that has since moved gets its nights
// reinterpreted in the new zone. That is the best available answer and the same one
// the parser now gives a fresh import; the alternative — leaving the rows as a value
// with no meaning at all — is strictly worse. A user who disagrees about a specific
// night can edit it, and the lock then protects the correction.
//
// Determinism rule (spec): reads only the DB and its own constants. The wall-clock
// conversion is INLINED rather than imported from lib/date so this migration's
// behavior is frozen with its hash, as the spec requires of migrations from 002 on.
// It still depends on the runtime's IANA database, which is unavoidable for any
// zone conversion and is stable for the recent dates a Fitbit archive covers.

const SLEEP_METRICS = [
  "sleep_min",
  "sleep_deep_min",
  "sleep_rem_min",
  "sleep_light_min",
  "sleep_awake_min",
];

const TAKEOUT_SOURCE = "fitbit-takeout";

// The unit-separator the tombstone key joins its components with (see
// lib/integrations/tombstone-keys.ts). Inlined per the determinism rule.
const SEP = String.fromCharCode(0x1f);

const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

// Offset (ms) of `tz` from UTC at instant `at`. Reads the zone's actual wall clock at
// that instant, so it is DST-correct.
function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = g("hour");
  if (hour === 24) hour = 0; // some ICU builds emit "24" for midnight
  return (
    Date.UTC(
      g("year"),
      g("month") - 1,
      g("day"),
      hour,
      g("minute"),
      g("second")
    ) - at.getTime()
  );
}

// The absolute instant a zoneless wall clock denotes in `tz`, as a canonical `Z`
// string. Null for anything that is not a bare wall clock — including a value that
// already states its own zone, which is what makes this migration re-runnable.
// Two-pass so a wall time near a DST transition settles on the offset actually in
// force at the resulting instant.
function toInstant(wall: string, tz: string): string | null {
  const m = WALL_CLOCK.exec(wall.trim());
  if (!m) return null;
  const n = (i: number) => (m[i] === undefined ? 0 : Number(m[i]));
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  const [mo, day, hour, min, sec] = [n(2), n(3), n(4), n(5), n(6)];
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;
  const naiveUtc = Date.UTC(n(1), mo - 1, day, hour, min, sec, ms);
  if (Number.isNaN(naiveUtc)) return null;
  const first = new Date(naiveUtc - tzOffsetMs(tz, new Date(naiveUtc)));
  const inst = new Date(naiveUtc - tzOffsetMs(tz, first));
  return Number.isNaN(inst.getTime()) ? null : inst.toISOString();
}

function validZone(tz: string | undefined | null): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(metric_samples)").all() as {
    name: string;
  }[];
  // Replay-safe against an older shape: the lock column arrived in 115 and the
  // origin column in 083, and this migration reads both.
  if (!cols.some((c) => c.name === "edited")) return;
  if (!cols.some((c) => c.name === "origin")) return;

  const instanceTz = validZone(
    (
      db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as
        { value: string } | undefined
    )?.value
  );
  const zoneCache = new Map<number, string>();
  const zoneFor = (profileId: number): string => {
    const hit = zoneCache.get(profileId);
    if (hit !== undefined) return hit;
    const row = db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
      )
      .get(profileId) as { value: string } | undefined;
    const tz = validZone(row?.value) ?? instanceTz ?? "UTC";
    zoneCache.set(profileId, tz);
    return tz;
  };

  const placeholders = SLEEP_METRICS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, profile_id, metric, origin, start_time, end_time
         FROM metric_samples
        WHERE source = ? AND edited = 0 AND metric IN (${placeholders})`
    )
    .all(TAKEOUT_SOURCE, ...SLEEP_METRICS) as {
    id: number;
    profile_id: number;
    metric: string;
    origin: string | null;
    start_time: string;
    end_time: string;
  }[];

  const taken = db.prepare(
    `SELECT id FROM metric_samples
      WHERE profile_id = ? AND metric = ? AND source = ? AND origin IS ?
        AND start_time = ?`
  );
  const update = db.prepare(
    "UPDATE metric_samples SET start_time = ?, end_time = ? WHERE id = ?"
  );

  for (const row of rows) {
    // `<instant>#<stage>` on a stage row; the discriminator rides along unchanged.
    const hash = row.start_time.indexOf("#");
    const wall = hash === -1 ? row.start_time : row.start_time.slice(0, hash);
    const suffix = hash === -1 ? "" : row.start_time.slice(hash);
    const tz = zoneFor(row.profile_id);
    const start = toInstant(wall, tz);
    const end = toInstant(row.end_time, tz);
    // Both boundaries or neither: a half-converted window would be a duration
    // computed across two different interpretations, which is worse than the bug.
    if (!start || !end) continue;
    const nextStart = `${start}${suffix}`;
    if (nextStart === row.start_time && end === row.end_time) continue;
    // A converted key cannot collide with an unconverted one (a `Z` string never
    // equals a zoneless one) and two rows with the same wall clock could not have
    // coexisted under the unique index. The check is here for the case that index
    // is absent — an older at-rest shape — where a blind UPDATE would duplicate
    // rather than fail.
    const clash = taken.get(
      row.profile_id,
      row.metric,
      TAKEOUT_SOURCE,
      row.origin,
      nextStart
    ) as { id: number } | undefined;
    if (clash && clash.id !== row.id) continue;
    update.run(nextStart, end, row.id);
  }

  migrateSleepTombstones(db, zoneFor);
}

// A tombstone's natural key is [metric, source, origin, start_time]; the start_time
// component moves exactly as the row's did, or a user-deleted night returns on the
// next import.
function migrateSleepTombstones(
  db: Database.Database,
  zoneFor: (profileId: number) => string
): void {
  const rows = db
    .prepare(
      `SELECT id, profile_id, natural_key FROM import_tombstones
        WHERE target_table = 'metric_samples'`
    )
    .all() as { id: number; profile_id: number; natural_key: string }[];
  const update = db.prepare(
    "UPDATE import_tombstones SET natural_key = ? WHERE id = ?"
  );
  const drop = db.prepare("DELETE FROM import_tombstones WHERE id = ?");
  const seen = new Set<string>();
  for (const row of rows) {
    const parts = row.natural_key.split(SEP);
    if (parts.length !== 4) continue;
    const [metric, source, origin, startTime] = parts;
    if (source !== TAKEOUT_SOURCE || !SLEEP_METRICS.includes(metric)) continue;
    const hash = startTime.indexOf("#");
    const wall = hash === -1 ? startTime : startTime.slice(0, hash);
    const suffix = hash === -1 ? "" : startTime.slice(hash);
    const instant = toInstant(wall, zoneFor(row.profile_id));
    if (!instant) continue;
    const next = [metric, source, origin, `${instant}${suffix}`].join(SEP);
    if (next === row.natural_key) continue;
    // The converted key may already exist (an earlier partial run, or two zoneless
    // keys that resolve to one instant); the tombstone is a set membership, so a
    // duplicate is dropped rather than allowed to violate the unique index.
    const dedupe = `${row.profile_id}${SEP}${next}`;
    const existing = db
      .prepare(
        `SELECT id FROM import_tombstones
          WHERE profile_id = ? AND target_table = 'metric_samples'
            AND natural_key = ?`
      )
      .get(row.profile_id, next) as { id: number } | undefined;
    if (seen.has(dedupe) || existing) {
      drop.run(row.id);
      continue;
    }
    update.run(next, row.id);
    seen.add(dedupe);
  }
}

export const migration: Migration = {
  id: 155,
  name: "155-fitbit-sleep-instants",
  up,
};
