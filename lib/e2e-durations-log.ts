// The LOG route for the e2e sharding manifest (`e2e/spec-durations.json`).
//
// The manifest must be measured on a RUNNER — `scripts/gen-e2e-durations.ts`
// carries the numbers, and laptop weights plan CI's work at 1.16 max/mean against
// 1.05 for runner weights. The documented source is the `e2e-results-shard-*`
// artifacts, and an agent sandbox behind a filtering proxy cannot download one:
// the artifact LIST returns 200 and the download returns 403 CONNECT, so it reads
// as a permissions problem and is not. Job logs stay reachable, though not via
// curl — that endpoint redirects to the same blob host. See
// docs/internals/e2e-hygiene.md for the route that works.
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

// ── ONE RUN, NOT TWO (#2828) ────────────────────────────────────────────────
//
// The parse above is additive, and it has to be: twelve shard inputs from ONE run
// carry disjoint file sets, and the manifest is their union. Across two whole
// RUNS the same additivity is a silent doubling, and nothing in the arithmetic
// can tell the two cases apart — the manifest replaced in #2825 was ~1.9x high
// for exactly this reason (`252913ec` says in its own commit message that it was
// built from two runs), with a median old/new per-file ratio of 2.01.
//
// A uniform 2x would cancel, because the planner only reads the weight ORDER.
// This one was not uniform — run-to-run variance on individual files spread the
// ratios from 1.10 to 4.86, which reorders the heavy specs and degrades the plan.
//
// The DATA distinguishes the cases precisely, where the arithmetic cannot: a spec
// file is the sharding atom, so it lives in exactly one shard, so one run's
// inputs never name the same file twice. A file appearing in two inputs means
// more than one run.

/** One input's contribution: where it came from, and the spec files it named. */
export interface DurationInputFiles {
  source: string;
  files: readonly string[];
}

/** A spec file more than one input named, and the inputs that named it. */
export interface DuplicateSpecFile {
  file: string;
  sources: string[];
}

/**
 * Spec files named by more than one input, sorted by file.
 *
 * Empty for one run's shards, however many there are. Non-empty means the inputs
 * span more than one run (or repeat one shard) — see `duplicateRunRefusal`.
 */
export function crossInputDuplicates(
  inputs: readonly DurationInputFiles[]
): DuplicateSpecFile[] {
  const sourcesByFile = new Map<string, string[]>();
  for (const input of inputs) {
    // A single input naming one file twice is that input's own business; the
    // signal is the file crossing an input boundary.
    for (const file of new Set(input.files)) {
      const seen = sourcesByFile.get(file);
      if (seen) seen.push(input.source);
      else sourcesByFile.set(file, [input.source]);
    }
  }
  return [...sourcesByFile]
    .filter(([, sources]) => sources.length > 1)
    .map(([file, sources]) => ({ file, sources }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** The flag that spells the one legitimate duplicate: a single shard re-run. */
export const ALLOW_RERUN_FLAG = "--allow-rerun";

/** How many duplicated files to name before saying "and N more". */
const MAX_LISTED_DUPLICATES = 10;

/** What the generator prints before refusing a set of inputs. */
export function duplicateRunRefusal(
  duplicates: readonly DuplicateSpecFile[]
): string {
  const listed = duplicates
    .slice(0, MAX_LISTED_DUPLICATES)
    .map((d) => `  ${d.file} — ${d.sources.join(", ")}`);
  const rest = duplicates.length - listed.length;
  if (rest > 0) listed.push(`  ...and ${rest} more`);
  return [
    `refusing: ${duplicates.length} spec file(s) appear in more than one input, ` +
      `so these inputs are not one CI run. A spec file lives in exactly one ` +
      `shard, so one run's inputs never name the same file twice.`,
    ...listed,
    `Summing two runs is what makes a manifest ~2x high (#2828, #2825). The ` +
      `doubling is not uniform — run-to-run variance reorders the heavy specs — ` +
      `so it does not cancel the way a constant factor would.`,
    `Feed one run's shards. If this really is ONE shard re-run and you want both ` +
      `attempts summed, pass ${ALLOW_RERUN_FLAG}.`,
  ].join("\n");
}
