// The log route into the e2e sharding manifest (`lib/e2e-durations-log.ts`).
//
// The manifest must be measured on a RUNNER — `scripts/gen-e2e-durations.ts`
// carries the numbers, and laptop weights plan CI's work at 1.16 max/mean against
// 1.05 for runner weights. Its documented source is the `e2e-results-shard-*`
// artifacts, which an agent sandbox behind a filtering proxy cannot download: the
// artifact LIST returns 200 and the download returns 403 CONNECT. Job logs are
// plain API reads, so each shard prints its per-file totals too.
//
// What this pins is the property that makes the second route safe — a printed
// line carries the same number the JSON path sums, so the two cannot drift into
// producing different manifests from one run. Spelling the emit and the parse
// both right is not the same as showing they meet (#2677); the round trip is
// where they meet.
import { describe, expect, it } from "vitest";
import {
  DURATION_LOG_TAG,
  formatDurationLog,
  parseDurationLog,
} from "../e2e-durations-log";

/** A log the way the API hands one back: tagged lines inside runner noise. */
function asCiLog(lines: string[]): string {
  return [
    "2026-08-14T03:00:00.0000000Z ##[group]Run npx tsx scripts/gen-e2e-durations.ts",
    ...lines.map((l) => `2026-08-14T03:00:01.0000000Z ${l}`),
    "2026-08-14T03:00:02.0000000Z ##[endgroup]",
  ].join("\n");
}

describe("e2e duration log lines", () => {
  it("prints one tagged, tab-separated line per spec file, sorted", () => {
    const lines = formatDurationLog(
      new Map([
        ["e2e/zulu.spec.ts", 450],
        ["e2e/alpha.spec.ts", 1500],
      ])
    );
    expect(lines).toEqual([
      `${DURATION_LOG_TAG}\te2e/alpha.spec.ts\t1500`,
      `${DURATION_LOG_TAG}\te2e/zulu.spec.ts\t450`,
    ]);
  });

  it("rounds to whole milliseconds — the manifest keeps 1dp seconds", () => {
    expect(formatDurationLog(new Map([["e2e/a.spec.ts", 1500.6]]))).toEqual([
      `${DURATION_LOG_TAG}\te2e/a.spec.ts\t1501`,
    ]);
  });

  it("round-trips through a noisy runner log", () => {
    // THE PROPERTY. If emit and parse ever disagree, one of the two sources is
    // lying about what CI measured, and the manifest silently reshuffles around
    // the lie.
    const totals = new Map([
      ["e2e/alpha.spec.ts", 1500],
      ["e2e/beta.spec.ts", 450],
    ]);
    const back = new Map<string, number>();
    const found = parseDurationLog(asCiLog(formatDurationLog(totals)), back);
    expect(found).toBe(2);
    expect(back).toEqual(totals);
  });

  it("sums the same file across several shards", () => {
    // A spec file is the sharding atom, so one file lands in one shard — but the
    // reader must be additive anyway, because a re-run or a `--repeat-each` log
    // pasted in twice would otherwise take the last value instead of the total.
    const totals = new Map<string, number>();
    parseDurationLog(
      asCiLog([`${DURATION_LOG_TAG}\te2e/a.spec.ts\t1000`]),
      totals
    );
    parseDurationLog(
      asCiLog([`${DURATION_LOG_TAG}\te2e/a.spec.ts\t250`]),
      totals
    );
    expect(totals.get("e2e/a.spec.ts")).toBe(1250);
  });

  it("reports zero for a log that predates the emit step", () => {
    // The failure the count exists for. An OLDER run's log has no tagged lines,
    // so it parses to nothing — and contributing nothing silently would
    // understate every file that shard owned. "No lines matched" and "this shard
    // ran nothing" look identical in a total, so the caller has to be able to
    // tell them apart; the script turns this zero into a hard error.
    const totals = new Map<string, number>();
    const found = parseDurationLog(
      "2026-08-14T03:00:00Z Run npx playwright test\n38 passed (1.1m)\n",
      totals
    );
    expect(found).toBe(0);
    expect(totals.size).toBe(0);
  });

  it("ignores a line whose duration is not a number", () => {
    const totals = new Map<string, number>();
    const found = parseDurationLog(
      asCiLog([
        `${DURATION_LOG_TAG}\te2e/a.spec.ts\tNaN`,
        `${DURATION_LOG_TAG}\te2e/b.spec.ts\t500`,
      ]),
      totals
    );
    expect(found).toBe(1);
    expect([...totals]).toEqual([["e2e/b.spec.ts", 500]]);
  });
});
