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
  ALLOW_RERUN_FLAG,
  crossInputDuplicates,
  DURATION_LOG_TAG,
  duplicateRunRefusal,
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

  it("sums the same file across two logs — ONE shard re-run, not two runs", () => {
    // WHICH duplicate this blesses (#2828). A spec file is the sharding atom, so
    // it lands in exactly one shard, and one run's shard logs never repeat a
    // file. The reader is additive for the case where a SINGLE shard was re-run:
    // both attempts are cost that run paid, and taking the last value would drop
    // one of them.
    //
    // It is emphatically NOT additive so that two whole RUNS can be pasted in.
    // That is a silent doubling — it is what made the manifest replaced in #2825
    // ~1.9x high — and the parse cannot see it, because once two numbers are
    // added the two cases ARE one number. Only the per-input file sets can tell
    // them apart, which is what `crossInputDuplicates` reads, below.
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

describe("inputs that span more than one run", () => {
  // THE SIGNAL (#2828). The manifest replaced in #2825 was ~1.9x high because it
  // was built from two CI runs summed rather than averaged, and the arithmetic
  // could not object: summing is exactly right for one run's twelve disjoint
  // shards. What separates the cases is not the numbers but the FILE SETS — a
  // spec file is the sharding atom, so it lives in one shard, so one run's inputs
  // partition the suite and never overlap.

  it("passes one run's shards, however many, because their file sets are disjoint", () => {
    expect(
      crossInputDuplicates([
        { source: "shard-1.log", files: ["e2e/a.spec.ts", "e2e/b.spec.ts"] },
        { source: "shard-2.log", files: ["e2e/c.spec.ts"] },
        { source: "shard-3.log", files: ["e2e/d.spec.ts", "e2e/e.spec.ts"] },
      ])
    ).toEqual([]);
  });

  it("names the file and both inputs when one file crosses an input boundary", () => {
    expect(
      crossInputDuplicates([
        { source: "run-a-shard-1.log", files: ["e2e/a.spec.ts"] },
        { source: "run-b-shard-1.log", files: ["e2e/a.spec.ts"] },
      ])
    ).toEqual([
      {
        file: "e2e/a.spec.ts",
        sources: ["run-a-shard-1.log", "run-b-shard-1.log"],
      },
    ]);
  });

  it("catches two whole runs, not just the shard that happens to collide", () => {
    // The real shape of the bad manifest: every file in the suite reported twice.
    const runA = ["e2e/a.spec.ts", "e2e/b.spec.ts"];
    const runB = ["e2e/a.spec.ts", "e2e/b.spec.ts"];
    const dupes = crossInputDuplicates([
      { source: "run-a.log", files: runA },
      { source: "run-b.log", files: runB },
    ]);
    expect(dupes.map((d) => d.file)).toEqual([
      "e2e/a.spec.ts",
      "e2e/b.spec.ts",
    ]);
  });

  it("ignores a file repeated INSIDE one input — that is one shard's own log", () => {
    // A `--repeat-each` shard prints the same file more than once in its own log,
    // and `parseDurationLog` has already summed those into a single entry by the
    // time this runs. The boundary being watched is between inputs.
    expect(
      crossInputDuplicates([
        {
          source: "shard-1.log",
          files: ["e2e/a.spec.ts", "e2e/a.spec.ts", "e2e/b.spec.ts"],
        },
      ])
    ).toEqual([]);
  });

  it("refuses with the duplicated files, the 2x, and the way to say re-run", () => {
    const msg = duplicateRunRefusal([
      { file: "e2e/a.spec.ts", sources: ["run-a.log", "run-b.log"] },
    ]);
    expect(msg).toContain("e2e/a.spec.ts — run-a.log, run-b.log");
    expect(msg).toContain("2x");
    expect(msg).toContain(ALLOW_RERUN_FLAG);
  });

  it("truncates a long list rather than printing the whole suite", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      file: `e2e/spec-${i}.spec.ts`,
      sources: ["run-a.log", "run-b.log"],
    }));
    const msg = duplicateRunRefusal(many);
    expect(msg).toContain("14 spec file(s)");
    expect(msg).toContain("...and 4 more");
    expect(msg).not.toContain("e2e/spec-10.spec.ts");
  });
});
