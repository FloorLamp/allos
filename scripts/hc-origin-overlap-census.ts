// Does any Health Connect ORIGIN legitimately emit overlapping same-metric windows?
// (#3424's verification step, mirroring #1101's step 4.)
//
//   npm run census:hc-overlaps                        # the captured payloads in data/
//   npm run census:hc-overlaps -- /path/to/payloads   # any directory of them
//
// WHY THIS EXISTS. #3424 makes an incoming Health Connect interval DELETE the stored
// rows its `[started_at, ended_at)` window overlaps, within
// (profile, metric, source = health-connect, origin). That is only safe if an overlap
// inside one such group is ALWAYS the mixed-anchoring anomaly and never a shape some
// origin app emits on purpose. The argument from the parser is:
//
//   • The additive `daily` families — steps, distance, active/total calories,
//     hydration, nutrition (SOURCE_FIDELITY) — arrive as the exporter's AGGREGATION
//     BUCKETS. Health Connect's own aggregate-by-period/duration partitions a span:
//     its buckets tile, they do not overlap, at `daily` or at any sub-daily setting.
//   • Sleep is per-session plus per-stage. Stages inside a session are sequential, and
//     each stage BUCKET is its own metric (`sleep_deep_min`, `sleep_rem_min`, …), so
//     two rows of one metric never nest. `sleep_min` is one row per session.
//   • Everything else the parser routes to `metric_samples` is a POINT reading
//     (`started_at === ended_at`: HRV, skin-temperature delta, lean/bone mass, BMR,
//     height), which lib/metric-window-overlap.ts excludes from the rule outright.
//
// This script is the EMPIRICAL half of that argument: it re-parses every captured
// exporter payload with the shipped parser and reports any same-(metric, origin)
// overlap, both WITHIN one push and ACROSS the whole capture. It is READ-ONLY and
// never opens the database.
//
// It is a probe, not a gate — the captures are gitignored production payloads, so it
// cannot be a test. Re-run it whenever the parser gains a record type.

import "./load-env";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseHealthConnectPayload } from "../lib/integrations/health-connect";
import { windowsOverlap } from "../lib/metric-window-overlap";

const log = (line: string) => {
  // eslint-disable-next-line no-console
  console.log(line);
};

// The zone only affects the `date` column, which this census does not read — the
// overlap rule compares INSTANTS. Fixed so a run is reproducible anywhere.
const TZ = "UTC";

interface Row {
  metric: string;
  origin: string | null;
  started_at: string;
  ended_at: string;
  file: string;
}

function payloadFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...payloadFiles(full));
      continue;
    }
    if (entry.startsWith("health-connect-") && entry.endsWith(".json")) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Every unordered pair of `rows` whose windows overlap, described. */
function overlappingPairs(rows: Row[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (!windowsOverlap(a.started_at, a.ended_at, b.started_at, b.ended_at)) {
        continue;
      }
      out.push(
        `${a.metric} / origin=${a.origin ?? "(none)"}: ` +
          `[${a.started_at}, ${a.ended_at}) x [${b.started_at}, ${b.ended_at})` +
          `  (${path.basename(a.file)} / ${path.basename(b.file)})`
      );
    }
  }
  return out;
}

function groupKey(row: Row): string {
  return `${row.metric} | ${row.origin ?? ""}`;
}

function main(): void {
  const root = path.resolve(
    process.argv[2] ?? path.join(process.cwd(), "data", "integration-payloads")
  );
  let files: string[];
  try {
    files = payloadFiles(root);
  } catch {
    log(`no captured payloads under ${root} — nothing to census`);
    return;
  }
  log(`payload captures: ${files.length}  (${root})`);

  const withinPush: string[] = [];
  const everything = new Map<string, Row[]>();
  let samples = 0;
  let intervals = 0;

  for (const file of files) {
    const parsed = parseHealthConnectPayload(
      JSON.parse(readFileSync(file, "utf8")),
      TZ
    );
    samples += parsed.samples.length;
    const push = new Map<string, Row[]>();
    for (const s of parsed.samples) {
      const row: Row = {
        metric: s.metric,
        origin: s.origin ?? null,
        started_at: s.started_at,
        ended_at: s.ended_at,
        file,
      };
      if (
        windowsOverlap(
          row.started_at,
          row.ended_at,
          row.started_at,
          row.ended_at
        )
      ) {
        intervals++;
      }
      const key = groupKey(row);
      push.set(key, [...(push.get(key) ?? []), row]);
      everything.set(key, [...(everything.get(key) ?? []), row]);
    }
    for (const rows of push.values())
      withinPush.push(...overlappingPairs(rows));
  }

  log(
    `samples parsed: ${samples}  (interval rows the supersede rule can act on: ${intervals})`
  );

  log("");
  log("WITHIN ONE PUSH — overlapping same-(metric, origin) windows:");
  log(withinPush.length ? withinPush.join("\n") : "  NONE");

  log("");
  log("ACROSS EVERY CAPTURE — the shape stored history would take:");
  const across: string[] = [];
  for (const rows of everything.values()) {
    // Collapse on the natural key the upsert uses (metric, origin, started_at),
    // keeping the furthest-reaching end, so a re-sent moving-end snapshot is not
    // reported as an overlap with itself.
    const byStart = new Map<string, Row>();
    for (const row of rows) {
      const prev = byStart.get(row.started_at);
      if (!prev || prev.ended_at < row.ended_at)
        byStart.set(row.started_at, row);
    }
    across.push(...overlappingPairs([...byStart.values()]));
  }
  log(across.length ? across.join("\n") : "  NONE");

  log("");
  const metrics = [
    ...new Set([...everything.keys()].map((k) => k.split(" | ")[0])),
  ];
  const origins = [
    ...new Set([...everything.keys()].map((k) => k.split(" | ")[1])),
  ];
  log(`metrics seen: ${metrics.sort().join(", ") || "(none)"}`);
  log(
    `origins seen: ${
      origins
        .map((o) => o || "(none)")
        .sort()
        .join(", ") || "(none)"
    }`
  );
}

main();
