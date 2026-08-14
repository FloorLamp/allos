// The LOG route for the e2e sharding manifest (`e2e/spec-durations.json`).
//
// The manifest must be measured on a RUNNER — `scripts/gen-e2e-durations.ts`
// carries the numbers, and laptop weights plan CI's work at 1.16 max/mean against
// 1.05 for runner weights. The documented source is the `e2e-results-shard-*`
// artifacts, and an agent sandbox behind a filtering proxy cannot download one:
// the artifact LIST returns 200 and the download returns 403 CONNECT, so it reads
// as a permissions problem and is not. Job logs are plain API reads.
//
// So each shard also PRINTS its per-file totals, one tagged line per spec file,
// and this module is the two halves of that channel. Tab-separated because a spec
// path never contains a tab and the reader is a regex over a log, not a parser.
// Whole milliseconds because the manifest rounds to 1dp seconds anyway.

/** Prefix that makes a duration line greppable out of a noisy CI log. */
export const DURATION_LOG_TAG = "e2e-durations";

/** One line per spec file, sorted, for a log reader to recover later. */
export function formatDurationLog(
  totals: ReadonlyMap<string, number>
): string[] {
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, ms]) => `${DURATION_LOG_TAG}\t${file}\t${Math.round(ms)}`);
}

/**
 * Sum the tagged lines out of a saved CI log into `totals`, returning how many
 * were found.
 *
 * Tolerant of everything around them on purpose — a log carries timestamps, ANSI
 * and `##[group]` noise, and the caller is pasting whatever the API returned. The
 * COUNT is the caller's business: zero lines and "this shard ran nothing" look
 * identical in a total, and only one of them is fine, so the caller has to be able
 * to tell them apart rather than reading a silent zero as data.
 */
export function parseDurationLog(
  src: string,
  totals: Map<string, number>
): number {
  const re = new RegExp(
    `${DURATION_LOG_TAG}\\t(\\S+)\\t(\\d+(?:\\.\\d+)?)`,
    "g"
  );
  let found = 0;
  for (const m of src.matchAll(re)) {
    const ms = Number(m[2]);
    if (!Number.isFinite(ms)) continue;
    totals.set(m[1], (totals.get(m[1]) ?? 0) + ms);
    found++;
  }
  return found;
}
