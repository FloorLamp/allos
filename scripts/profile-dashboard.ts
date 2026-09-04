// Profile the dashboard render over a copy of a real database (#5010).
//
//   npm run profile:dashboard -- --db ~/snapshots/allos.db
//   npm run profile:dashboard -- --db ~/snapshots/allos.db --profile 1 \
//       --now 2026-09-04T01:10:00Z --renders 3 --out data/profiles/today
//
// WHAT IT MEASURES. One `Dashboard()` render per pass, through the same harness the
// query meter (`lib/__db_tests__/dashboard-placement-manifest.test.ts`) counts with,
// so the statements it times are the statements the meter budgets. Three readings:
//   - per render: wall time, statement count, time inside SQLite;
//   - per statement: total time, count, and the app frame that ran it;
//   - a V8 CPU profile of the renders after the warm-up, summarised here by self
//     time per function and per file and by inclusive time per app frame, and kept
//     as `render.cpuprofile` for a browser's Performance panel.
//
// NEVER THE FILE YOU PASS. The database is copied before anything opens it: a render
// may write (recent pages, reconcile flags), and a snapshot must stay a snapshot. The
// copy lives in `--out` and is removed unless `--keep-copy`.
//
// The render itself runs inside vitest (`lib/__db_tests__/dashboard-profile.test.ts`)
// because the page reads Next's request cookies and the harness fakes those with
// `vi.mock`; this script is the front door that sets the PROBE_* environment, runs
// that one file, and reads its output back.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface Args {
  db: string;
  now?: string;
  profile?: string;
  renders: string;
  out: string;
  keepCopy: boolean;
  top: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { renders: "3", keepCopy: false, top: 18 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--db":
        args.db = value;
        i += 1;
        break;
      case "--now":
        args.now = value;
        i += 1;
        break;
      case "--profile":
        args.profile = value;
        i += 1;
        break;
      case "--renders":
        args.renders = value;
        i += 1;
        break;
      case "--out":
        args.out = value;
        i += 1;
        break;
      case "--top":
        args.top = Number(value);
        i += 1;
        break;
      case "--keep-copy":
        args.keepCopy = true;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!args.db) throw new Error("--db <path to a database file> is required");
  if (!args.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    args.out = path.join("data", "profiles", `dashboard-${stamp}`);
  }
  return args as Args;
}

interface StatementReport {
  sql: string;
  count: number;
  ms: number;
  callers: { caller: string; ms: number }[];
}
interface Report {
  db: string;
  now: string;
  profileId: number;
  renders: { wall: number; statements: number; sqlMs: number }[];
  statements: StatementReport[];
}
interface CpuNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface CpuProfile {
  nodes: CpuNode[];
  samples: number[];
  timeDeltas: number[];
}

const APP = /^(app|lib|components)\//;
function shortUrl(url: string): string {
  return url.replace(/^.*?\/(app|lib|components)\//, "$1/") || "(native)";
}
function frameLabel(node: CpuNode): string {
  const { functionName, url, lineNumber } = node.callFrame;
  return `${functionName || "(anon)"} ${shortUrl(url)}:${lineNumber + 1}`;
}

function summariseCpu(profile: CpuProfile, top: number): string[] {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes)
    for (const child of n.children ?? []) parent.set(child, n.id);
  const self = new Map<number, number>();
  profile.samples.forEach((id, i) =>
    self.set(id, (self.get(id) ?? 0) + profile.timeDeltas[i])
  );
  const byFunction = new Map<string, number>();
  const byFile = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let total = 0;
  for (const [id, us] of self) {
    total += us;
    const node = nodes.get(id)!;
    const label = frameLabel(node);
    byFunction.set(label, (byFunction.get(label) ?? 0) + us);
    const file = shortUrl(node.callFrame.url);
    byFile.set(file, (byFile.get(file) ?? 0) + us);
    const seen = new Set<number>();
    let current: number | undefined = id;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const l = frameLabel(nodes.get(current)!);
      inclusive.set(l, (inclusive.get(l) ?? 0) + us);
      current = parent.get(current);
    }
  }
  const ms = (us: number) => `${Math.round(us / 1000)}`.padStart(7);
  const lines = [`CPU profile: ${Math.round(total / 1000)} ms sampled`];
  lines.push("  self time by function");
  for (const [k, v] of [...byFunction]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top))
    lines.push(`  ${ms(v)} ms  ${k}`);
  lines.push("  self time by file");
  for (const [k, v] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12))
    lines.push(`  ${ms(v)} ms  ${k}`);
  lines.push("  inclusive time, app frames");
  let shown = 0;
  for (const [k, v] of [...inclusive].sort((a, b) => b[1] - a[1])) {
    if (!APP.test(k.split(" ")[1] ?? "")) continue;
    lines.push(`  ${ms(v)} ms  ${k}`);
    if ((shown += 1) >= top + 8) break;
  }
  return lines;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const copy = path.resolve(args.out, "snapshot-copy.db");
  fs.copyFileSync(args.db, copy);
  for (const sidecar of ["-wal", "-shm"])
    fs.rmSync(copy + sidecar, { force: true });

  const env = {
    ...process.env,
    PROBE_DB: copy,
    PROBE_OUT: path.resolve(args.out),
    PROBE_RENDERS: args.renders,
    ...(args.now ? { PROBE_NOW: args.now } : {}),
    ...(args.profile ? { PROBE_PROFILE: args.profile } : {}),
  };
  const run = spawnSync(
    process.execPath,
    [
      path.join("node_modules", "vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.db.config.ts",
      "lib/__db_tests__/dashboard-profile.test.ts",
    ],
    { env, encoding: "utf8" }
  );
  fs.writeFileSync(path.join(args.out, "vitest.log"), run.stdout + run.stderr);
  if (run.status !== 0) {
    process.stderr.write(run.stdout + run.stderr);
    throw new Error(`the profile render failed (see ${args.out}/vitest.log)`);
  }

  const report = JSON.parse(
    fs.readFileSync(path.join(args.out, "profile.json"), "utf8")
  ) as Report;
  const profile = JSON.parse(
    fs.readFileSync(path.join(args.out, "render.cpuprofile"), "utf8")
  ) as CpuProfile;
  if (!args.keepCopy) fs.rmSync(copy, { force: true });

  const out: string[] = [];
  out.push(
    `dashboard profile · profile ${report.profileId} · now ${report.now}`
  );
  out.push(`source ${args.db}`);
  out.push("renders (the first warms the module graph)");
  report.renders.forEach((r, i) =>
    out.push(
      `  ${i + 1}: wall ${r.wall} ms · ${r.statements} statements · ${r.sqlMs} ms in SQLite`
    )
  );
  out.push(`statements by time (last render)`);
  for (const s of report.statements.slice(0, args.top))
    out.push(
      `  ${s.ms.toFixed(1).padStart(8)} ms  x${String(s.count).padEnd(4)} ${(
        s.callers[0]?.caller ?? "?"
      ).padEnd(44)} ${s.sql.slice(0, 96)}`
    );
  const byCaller = new Map<string, number>();
  for (const s of report.statements)
    for (const c of s.callers)
      byCaller.set(c.caller, (byCaller.get(c.caller) ?? 0) + c.ms);
  out.push("SQLite time by caller");
  for (const [caller, ms] of [...byCaller]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12))
    out.push(`  ${Math.round(ms).toString().padStart(6)} ms  ${caller}`);
  out.push("most frequent statements");
  for (const s of [...report.statements]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8))
    out.push(`  x${String(s.count).padEnd(5)} ${s.sql.slice(0, 96)}`);
  out.push(...summariseCpu(profile, args.top));
  out.push(`written: ${args.out}/profile.json, render.cpuprofile, vitest.log`);
  const text = out.join("\n");
  fs.writeFileSync(path.join(args.out, "summary.txt"), text + "\n");
  process.stdout.write(text + "\n");
}

main();
