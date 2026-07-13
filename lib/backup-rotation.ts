// Pure decision logic for automated SQLite backups (issue #131): parsing snapshot
// filenames, deciding when a backup is due, and choosing which snapshots to keep
// vs prune under a keep-N-dailies + M-weeklies policy. No DB/fs/network, so it's
// unit-tested in lib/__tests__; the fs/VACUUM side lives in lib/backup.ts.

import { slotDue } from "./notifications/schedule";

// Snapshot filename: allos-YYYY-MM-DD-HHmm.db (local date+time of the snapshot).
const NAME_RE = /^allos-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.db$/;

export interface BackupStamp {
  name: string;
  date: string; // YYYY-MM-DD
  sort: string; // sortable "YYYY-MM-DD-HHmm" (newest = greatest)
  weekKey: string; // ISO week bucket, e.g. "2026-W27"
}

// Build a snapshot filename for a local date (YYYY-MM-DD) and time (HH:MM).
export function backupFilename(date: string, hhmm: string): string {
  return `allos-${date}-${hhmm.replace(":", "")}.db`;
}

// Parse a snapshot filename; null when it isn't one of ours (so foreign files in
// the directory are never considered for pruning).
export function parseBackupStamp(name: string): BackupStamp | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const date = `${y}-${mo}-${d}`;
  return {
    name,
    date,
    sort: `${date}-${hh}${mm}`,
    weekKey: isoWeekKey(date),
  };
}

// Pre-restore aside filename: "<liveBase>.pre-restore-<ISO-ish stamp>" (see
// restoreCore). The stamp has ':' and '.' replaced with '-', so it stays sortable
// (newest = lexicographically greatest). Its -wal/-shm siblings (#472) are NOT
// asides themselves and are excluded here — they're pruned alongside their main.
const ASIDE_SUFFIX_RE = /\.pre-restore-[0-9TZ-]+$/;

// Which pre-restore aside MAIN files to prune, keeping the newest `keepN` (#472).
// Aside files (`allos.db.pre-restore-*`) otherwise accumulate in data/ forever;
// the tick prunes them like snapshot rotation. `liveBase` is the live DB's
// basename (e.g. "allos.db"); only that DB's asides are considered. Pure — the
// caller lists the directory and unlinks each returned main + its -wal/-shm.
export function planAsidePrune(
  names: string[],
  liveBase: string,
  keepN: number
): string[] {
  const prefix = `${liveBase}.pre-restore-`;
  const asides = names
    .filter((n) => n.startsWith(prefix) && ASIDE_SUFFIX_RE.test(n))
    .sort(); // ISO-ish stamp → lexicographic == chronological
  const keep = Math.max(0, Math.floor(keepN));
  return keep >= asides.length ? [] : asides.slice(0, asides.length - keep);
}

// ISO-8601 week bucket ("YYYY-Www") for a YYYY-MM-DD date. UTC-anchored so it's
// timezone-independent; weeks start Monday and week 1 contains the year's first
// Thursday.
export function isoWeekKey(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00Z");
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const thursday = date.getTime();
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 + Math.round((thursday - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export interface BackupPolicy {
  keepDaily: number; // most-recent snapshots kept as dailies
  keepWeekly: number; // additional older weeks kept (newest per week)
}

// A snapshot's verification standing, derived from its sidecar (#622):
//  - "ok":         sidecar says integrity ok → keeper-eligible + restorable.
//  - "failed":     sidecar says integrity failed → kept on disk for forensics
//                  (performBackup never prunes the current bad file) but NEVER a
//                  retention keeper, so a corrupt file can't evict a good one.
//  - "unverified": no readable sidecar → a partial from a crashed VACUUM INTO (a
//                  mid-`HHmm`+1 retry leaves a differently-named partial the
//                  same-minute cleanup misses). Prune-eligible, never a keeper.
// Only "ok" snapshots occupy `keepDaily`/`keepWeekly` slots; the rest are still
// listed for pruning so they stop displacing verified snapshots and masquerading
// as the latest backup.
export type SnapshotStatus = "ok" | "failed" | "unverified";

// Decide which snapshots to keep and which to prune. Keeps the newest `keepDaily`
// VERIFIED snapshots outright, then, from what remains, the newest verified snapshot
// of each of the next `keepWeekly` distinct ISO weeks; everything else is pruned.
// Filenames that aren't ours are ignored entirely (neither kept nor pruned).
//
// `statusOf` classifies each snapshot by its verification sidecar (#622); it
// defaults to treating every file as "ok" so callers/tests that don't care about
// verification get the original filename-only behavior. Failed / unverified
// snapshots never count toward the keep quotas (they're keeper-INELIGIBLE) but are
// still returned in `prune` — the bad files are pruned like any other non-keeper.
export function planBackupRotation(
  names: string[],
  policy: BackupPolicy,
  statusOf: (name: string) => SnapshotStatus = () => "ok"
): { keep: string[]; prune: string[] } {
  const keepDaily = Math.max(0, Math.floor(policy.keepDaily));
  const keepWeekly = Math.max(0, Math.floor(policy.keepWeekly));

  const parsed = names
    .map(parseBackupStamp)
    .filter((s): s is BackupStamp => s !== null)
    .sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0)); // newest first

  // Only verified-ok snapshots are keeper-eligible; failed/unverified ones never
  // occupy a retention slot (#622).
  const eligible = parsed.filter((s) => statusOf(s.name) === "ok");

  const keep = new Set<string>();
  const dailies = eligible.slice(0, keepDaily);
  for (const s of dailies) keep.add(s.name);

  // From the older eligible remainder, keep the newest snapshot of each of the next
  // keepWeekly distinct weeks.
  const seenWeeks = new Set<string>();
  for (const s of eligible.slice(keepDaily)) {
    if (seenWeeks.has(s.weekKey)) continue;
    if (seenWeeks.size >= keepWeekly) break;
    seenWeeks.add(s.weekKey);
    keep.add(s.name);
  }

  const prune = parsed.filter((s) => !keep.has(s.name)).map((s) => s.name);
  return { keep: [...keep], prune };
}

// The newest VERIFIED-ok snapshot name, or null when none is verified (#622). Used
// by getLastBackup so Settings → Server reports a restorable snapshot as "the last
// backup" instead of a newer-but-corrupt/partial file. `statusOf` defaults to
// treating everything as "ok" (filename-only), preserving the old newest-by-name
// behavior for callers that don't pass verification info.
export function selectLatestVerified(
  names: string[],
  statusOf: (name: string) => SnapshotStatus = () => "ok"
): string | null {
  const verified = names
    .map(parseBackupStamp)
    .filter((s): s is BackupStamp => s !== null)
    .filter((s) => statusOf(s.name) === "ok")
    .sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0)); // newest first
  return verified.length > 0 ? verified[0].name : null;
}

// Whether a scheduled backup should run this tick: enabled, within the configured
// hour's window (same [hour, hour+1] retry window as notify slots), and none yet
// taken today (per-day dedup, like the notify_last_* markers).
export function isBackupDue(
  cfg: { enabled: boolean; hour: number },
  currentHour: number,
  lastBackupDate: string | undefined,
  today: string
): boolean {
  if (!cfg.enabled) return false;
  if (!slotDue(cfg.hour, currentHour)) return false;
  return lastBackupDate !== today;
}
