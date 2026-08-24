import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import {
  parseNameStatus,
  planPostMergeCensus,
} from "../../scripts/orchestration/post-merge-census.mjs";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(
  REPO,
  "scripts",
  "orchestration",
  "post-merge-census.mjs"
);

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function write(repo: string, file: string, content = "export default null;\n") {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeRepo(): string {
  const repo = makeTmpDir("post-merge-census-cli");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "census@example.test"]);
  git(repo, ["config", "user.name", "Census Test"]);
  write(repo, "app/(app)/page.tsx");
  write(repo, "app/(app)/trends/page.tsx");
  write(repo, "app/(app)/nutrition/page.tsx");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);
  return repo;
}

function commit(repo: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files))
    write(repo, file, content);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "change"]);
}

function runCli(
  repo: string,
  args: readonly string[],
  env: Record<string, string> = {}
) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const routes = [
  "/",
  "/medical/cycles",
  "/nutrition",
  "/settings",
  "/settings/display",
  "/trends",
  "/trends/metric/[kind]",
];

const changed = (file: string, status = "M") => ({
  status,
  paths: [file],
});

describe("post-merge census route planning", () => {
  it("maps app territories to truthful top-level route prefixes", () => {
    const plan = planPostMergeCensus(
      [
        changed("app/(app)/trends/TrendChart.tsx"),
        changed("app/(app)/medical/cycles/page.tsx"),
        changed("app/(app)/trends/page.tsx"),
      ],
      routes
    );
    expect(plan).toMatchObject({
      mode: "scoped",
      routes: ["/medical", "/trends"],
    });
  });

  it("falls back to every route when any shared component changes", () => {
    const plan = planPostMergeCensus(
      [changed("app/(app)/trends/page.tsx"), changed("components/Card.tsx")],
      routes
    );
    expect(plan).toEqual({
      mode: "full",
      routes,
      reasons: ["shared components changed"],
      mappedFiles: 2,
    });
  });

  it.each([
    "app/globals.css",
    "app/layout.tsx",
    "app/(app)/layout.tsx",
    "app/(app)/actions.ts",
    "app/(app)/page.tsx",
  ])("treats shared shell path %s as a full census", (file) => {
    expect(planPostMergeCensus([changed(file)], routes).mode).toBe("full");
  });

  it("fails when a changed app territory has no live census route", () => {
    expect(() =>
      planPostMergeCensus([changed("app/(app)/removed/Widget.tsx")], routes)
    ).toThrow("maps to no current census route");
  });

  it.each([
    "app/offline/page.tsx",
    "app/(marketing)/about/page.tsx",
    "app/(app)/(nested)/page.tsx",
  ])("fails loudly on unknown app shape %s", (file) => {
    expect(() => planPostMergeCensus([changed(file)], routes)).toThrow(
      "unknown app"
    );
  });

  it("fails loudly on deleted and renamed routes", () => {
    expect(() =>
      planPostMergeCensus([changed("app/(app)/trends/page.tsx", "D")], routes)
    ).toThrow("route deletion");
    expect(() =>
      planPostMergeCensus(
        [
          {
            status: "R100",
            paths: ["app/(app)/trends/page.tsx", "app/(app)/insights/page.tsx"],
          },
        ],
        routes
      )
    ).toThrow("route rename");
  });

  it("refuses empty and non-visual diffs instead of printing a no-op", () => {
    expect(() => planPostMergeCensus([], routes)).toThrow("no changed files");
    expect(planPostMergeCensus([changed("lib/date.ts")], routes)).toMatchObject(
      { mode: "full" }
    );
    expect(() =>
      planPostMergeCensus([changed("docs/census.md")], routes)
    ).toThrow("no changed file maps");
    expect(() =>
      planPostMergeCensus([changed("components/Card.tsx")], [])
    ).toThrow("empty route set");
  });
});

describe("post-merge census git records", () => {
  it("parses ordinary and rename records without losing either path", () => {
    expect(
      parseNameStatus(
        "M\0app/(app)/trends/page.tsx\0R091\0app/(app)/old/page.tsx\0app/(app)/new/page.tsx\0"
      )
    ).toEqual([
      { status: "M", paths: ["app/(app)/trends/page.tsx"] },
      {
        status: "R091",
        paths: ["app/(app)/old/page.tsx", "app/(app)/new/page.tsx"],
      },
    ]);
  });

  it("rejects malformed and unknown records", () => {
    expect(() => parseNameStatus("R100\0only-one-path\0")).toThrow(
      "incomplete git"
    );
    expect(() => parseNameStatus("Q\0mystery\0")).toThrow(
      "unknown git change status"
    );
  });
});

describe("post-merge census CLI boundary", () => {
  it.each(["lib/nav.ts", "lib/units.ts"])(
    "does not under-scope a mixed app + %s runtime diff",
    (runtimeFile) => {
      const repo = makeRepo();
      commit(repo, {
        "app/(app)/trends/Chart.tsx": "export const chart = 1;\n",
        [runtimeFile]: "export const shared = 1;\n",
      });

      const run = runCli(repo, ["HEAD^", "HEAD"]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("post-merge census: full (all)");
      expect(run.stdout).toContain("unmapped runtime/shared files changed");
      expect(run.stdout).not.toContain("UX_ROUTES=/trends");
    }
  );

  it("stops on an unknown app shape from a real git diff", () => {
    const repo = makeRepo();
    commit(repo, {
      "app/offline/page.tsx": "export default function Offline() {}\n",
    });

    const run = runCli(repo, ["HEAD^", "HEAD"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown app path shape");
  });

  it("stops on an empty ref range instead of printing a no-op command", () => {
    const repo = makeRepo();
    const run = runCli(repo, ["HEAD", "HEAD"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("contains no changed files");
    expect(run.stdout).not.toContain("ux-walkthrough");
  });

  it("owns a fresh database for every real --run child and cleans both", () => {
    const repo = makeRepo();
    const log = path.join(repo, "db-paths.log");
    const callerDb = path.join(repo, "caller-reused.db");
    write(
      repo,
      "scripts/ux-walkthrough.mjs",
      `import fs from "node:fs";
const db = process.env.ALLOS_DB_PATH;
if (!db) process.exit(40);
if (fs.existsSync(db)) process.exit(41);
fs.writeFileSync(db, "seeded");
fs.appendFileSync(process.env.CENSUS_DB_LOG, db + "\\n");
`
    );
    commit(repo, {
      "app/(app)/trends/Chart.tsx": "export const chart = 1;\n",
    });

    const env = { ALLOS_DB_PATH: callerDb, CENSUS_DB_LOG: log };
    const first = runCli(repo, ["HEAD^", "HEAD", "--run"], env);
    const second = runCli(repo, ["HEAD^", "HEAD", "--run"], env);
    expect(
      [first.status, second.status],
      `${first.stderr}\n${second.stderr}`
    ).toEqual([0, 0]);
    const dbPaths = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(new Set(dbPaths).size).toBe(2);
    expect(dbPaths).not.toContain(callerDb);
    for (const db of dbPaths) expect(fs.existsSync(db)).toBe(false);
    expect(fs.existsSync(callerDb)).toBe(false);
  });
});
