// Auth-blind write core for the mobility log (issue #840) — the tap-the-moves bar.
//
// A mobility session is ONE `activities` row of type `recovery` per (profile, date),
// whose `components` JSON is the list of tapped moves (ActivityComponent[]; each a move
// slug typed `recovery`, no per-move sets/weights — the HABIT-tier "one move = one tap"
// model, the false-precision trap /nutrition refuses). Being an ordinary activities row
// it rides the timeline/journal/streaks/heatmap for free.
//
// Storage shape mirrors the food log's per-(profile,date) upsert, but into `activities`
// rather than a counter table: toggling a move on adds it to the day's session (creating
// the row if absent); toggling it off removes it (deleting the row when it empties to
// nothing — no moves and no duration — so a fully-undone day leaves no ghost session).
// The move set is deduped (a move is present or absent, never a count).
//
// profileId-first, auth-blind (no lib/auth import) — the calling Server Action owns the
// auth gate + revalidate (lib/ write-core convention). Every mutation is a single
// writeTx (BEGIN IMMEDIATE, #468).

import { db, writeTx, today } from "./db";
import { parseComponents, type ActivityComponent } from "./types";
import {
  canonicalMobilityMove,
  mobilityMoveName,
} from "./mobility-moves";

// The default title for a mobility session. Kept stable so the row reads sanely on the
// timeline/journal without a per-move title.
const MOBILITY_TITLE = "Mobility";

export interface MobilitySession {
  activityId: number | null; // null when no session exists for the day yet
  moves: string[]; // canonical move slugs, in insertion order
  durationMin: number | null;
}

export type MobilityLogOutcome =
  | { kind: "logged"; session: MobilitySession }
  | { kind: "unknown-move" };

interface DayRow {
  id: number;
  components: string | null;
  duration_min: number | null;
}

// The day's recovery activity row (at most one per profile/date), or undefined.
function dayRow(profileId: number, date: string): DayRow | undefined {
  return db
    .prepare(
      `SELECT id, components, duration_min FROM activities
         WHERE profile_id = ? AND date = ? AND type = 'recovery'
         ORDER BY id ASC LIMIT 1`
    )
    .get(profileId, date) as DayRow | undefined;
}

// The move slugs stored on a recovery row's components (recovery-typed components only),
// deduped and order-preserving.
function movesOf(row: DayRow | undefined): string[] {
  if (!row) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of parseComponents(row.components)) {
    if (c.type !== "recovery" || typeof c.name !== "string") continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c.name);
  }
  return out;
}

function componentsFor(moves: string[]): ActivityComponent[] {
  return moves.map((slug) => ({
    name: slug,
    type: "recovery" as const,
    distance_km: null,
    duration_min: null,
  }));
}

function sessionOf(row: DayRow | undefined): MobilitySession {
  return {
    activityId: row?.id ?? null,
    moves: movesOf(row),
    durationMin: row?.duration_min ?? null,
  };
}

// Read the day's mobility session (auth-blind). Exposed for the query layer.
export function readMobilitySession(
  profileId: number,
  date: string
): MobilitySession {
  return sessionOf(dayRow(profileId, date));
}

// Add a move to the day's session (creating the row if absent). Idempotent — a move
// already present is a no-op. Persists the CANONICAL slug (#883). Returns the updated
// session, or `unknown-move` for a slug outside the catalog.
export function logMobilityMoveCore(
  profileId: number,
  rawSlug: string,
  date: string
): MobilityLogOutcome {
  const slug = canonicalMobilityMove(rawSlug);
  if (slug === null) return { kind: "unknown-move" };
  return writeTx(() => {
    const row = dayRow(profileId, date);
    const moves = movesOf(row);
    if (!moves.includes(slug)) moves.push(slug);
    const json = JSON.stringify(componentsFor(moves));
    if (row) {
      db.prepare(
        `UPDATE activities SET components = ?, updated_at = datetime('now')
           WHERE id = ? AND profile_id = ?`
      ).run(json, row.id, profileId);
      return { kind: "logged", session: sessionOf(dayRow(profileId, date)) };
    }
    db.prepare(
      `INSERT INTO activities (date, type, title, components, profile_id)
       VALUES (?, 'recovery', ?, ?, ?)`
    ).run(date, MOBILITY_TITLE, json, profileId);
    return { kind: "logged", session: sessionOf(dayRow(profileId, date)) };
  });
}

// Remove a move from the day's session. When the session empties to NOTHING (no moves
// and no overall duration) the row is deleted, so a fully-undone day leaves no ghost.
// Unknown slugs are tolerated (a retired slug still removes its stored component).
export function unlogMobilityMoveCore(
  profileId: number,
  rawSlug: string,
  date: string
): MobilityLogOutcome {
  // Removal matches on the stored (canonical) slug; fall back to the raw value so a
  // retired-catalog slug can still be pulled from an existing row.
  const slug = canonicalMobilityMove(rawSlug) ?? rawSlug;
  return writeTx(() => {
    const row = dayRow(profileId, date);
    if (!row) return { kind: "logged", session: sessionOf(undefined) };
    const moves = movesOf(row).filter((m) => m !== slug);
    if (moves.length === 0 && (row.duration_min ?? null) === null) {
      db.prepare(
        `DELETE FROM activities WHERE id = ? AND profile_id = ?`
      ).run(row.id, profileId);
      return { kind: "logged", session: sessionOf(undefined) };
    }
    db.prepare(
      `UPDATE activities SET components = ?, updated_at = datetime('now')
         WHERE id = ? AND profile_id = ?`
    ).run(JSON.stringify(componentsFor(moves)), row.id, profileId);
    return { kind: "logged", session: sessionOf(dayRow(profileId, date)) };
  });
}

// Set (or clear) the session's overall duration. A duration on a move-less day creates
// an (otherwise empty) session; clearing it to null on a move-less day deletes the row.
export function setMobilityDurationCore(
  profileId: number,
  date: string,
  minutes: number | null
): MobilitySession {
  const dur = minutes != null && minutes > 0 ? Math.round(minutes) : null;
  return writeTx(() => {
    const row = dayRow(profileId, date);
    if (!row) {
      if (dur === null) return sessionOf(undefined);
      db.prepare(
        `INSERT INTO activities (date, type, title, components, duration_min, profile_id)
         VALUES (?, 'recovery', ?, '[]', ?, ?)`
      ).run(date, MOBILITY_TITLE, dur, profileId);
      return sessionOf(dayRow(profileId, date));
    }
    if (dur === null && movesOf(row).length === 0) {
      db.prepare(
        `DELETE FROM activities WHERE id = ? AND profile_id = ?`
      ).run(row.id, profileId);
      return sessionOf(undefined);
    }
    db.prepare(
      `UPDATE activities SET duration_min = ?, updated_at = datetime('now')
         WHERE id = ? AND profile_id = ?`
    ).run(dur, row.id, profileId);
    return sessionOf(dayRow(profileId, date));
  });
}

// Convenience for tests/callers: the display names of a session's moves.
export function mobilitySessionMoveNames(session: MobilitySession): string[] {
  return session.moves.map(mobilityMoveName);
}

// The app-local "today" for a profile (re-export so callers don't double-import).
export function mobilityToday(profileId: number): string {
  return today(profileId);
}
