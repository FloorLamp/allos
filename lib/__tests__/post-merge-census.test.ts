import { execFileSync, spawn, spawnSync } from "node:child_process";
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

function installWalkthroughStub(repo: string, source: string): void {
  write(repo, "scripts/ux-walkthrough.mjs", source);
  git(repo, ["add", "scripts/ux-walkthrough.mjs"]);
  git(repo, ["commit", "-qm", "install walkthrough stub"]);
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

function runCliAsync(
  repo: string,
  args: readonly string[],
  env: Record<string, string> = {}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

interface ChildReceipt {
  argv: string[];
  cwd: string;
  db: string;
  routes: string;
  seed?: string;
  rng?: string;
  persona?: string;
}

function readReceipt(file: string): ChildReceipt {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ChildReceipt;
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

  it.each([
    {
      name: "scoped",
      changedFile: "app/(app)/trends/Chart.tsx",
      routes: "/trends",
    },
    {
      name: "full",
      changedFile: "components/Card.tsx",
      routes: "",
    },
  ])(
    "passes the complete $name plan through the real Git and spawn boundary",
    ({ changedFile, routes }) => {
      const repo = makeRepo();
      const receiptFile = path.join(repo, "child-receipt.json");
      const callerDb = path.join(repo, "caller-reused.db");
      installWalkthroughStub(
        repo,
        `import fs from "node:fs";
const db = process.env.ALLOS_DB_PATH;
if (!db) process.exit(40);
if (fs.existsSync(db)) process.exit(41);
fs.writeFileSync(db, "seeded");
fs.writeFileSync(process.env.CENSUS_RECEIPT, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), db,
  routes: process.env.UX_ROUTES,
}));
`
      );
      commit(repo, {
        [changedFile]: "export const changed = 1;\n",
      });

      const run = runCli(repo, ["HEAD^", "HEAD", "--run"], {
        ALLOS_DB_PATH: callerDb,
        UX_ROUTES: "/caller-must-not-win",
        CENSUS_RECEIPT: receiptFile,
      });
      expect(run.status, run.stderr).toBe(0);
      const receipt = readReceipt(receiptFile);
      expect(receipt).toMatchObject({
        argv: ["--serve", "pages"],
        cwd: fs.realpathSync(repo),
        routes,
      });
      expect(receipt.db).not.toBe(callerDb);
      expect(fs.existsSync(path.dirname(receipt.db))).toBe(false);
      expect(fs.existsSync(callerDb)).toBe(false);
    }
  );

  it("prints an executable plan that safely preserves the requested shape", () => {
    const repo = makeRepo();
    const receiptFile = path.join(repo, "shape-receipt.json");
    installWalkthroughStub(
      repo,
      `import fs from "node:fs";
fs.writeFileSync(process.env.CENSUS_RECEIPT, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), db: "",
  routes: process.env.UX_ROUTES, seed: process.env.UX_SEED,
  rng: process.env.SEED_RNG, persona: process.env.SEED_PERSONA,
}));
`
    );
    commit(repo, {
      "app/(app)/trends/Chart.tsx": "export const chart = 1;\n",
    });
    const shape = {
      UX_SEED: "1",
      SEED_RNG: "3; printf unsafe",
      SEED_PERSONA: "house hold's",
      CENSUS_RECEIPT: receiptFile,
    };

    const plan = runCli(repo, ["HEAD^", "HEAD"], shape);
    expect(plan.status, plan.stderr).toBe(0);
    const command = plan.stdout.trim().split("\n").at(-1);
    expect(command).toBeTruthy();
    const executed = spawnSync("/bin/sh", ["-c", command!], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, CENSUS_RECEIPT: receiptFile },
    });
    expect(executed.status, executed.stderr).toBe(0);
    expect(readReceipt(receiptFile)).toMatchObject({
      argv: ["--serve", "pages"],
      cwd: fs.realpathSync(repo),
      routes: "/trends",
      seed: shape.UX_SEED,
      rng: shape.SEED_RNG,
      persona: shape.SEED_PERSONA,
    });
  });

  it("propagates child failure and removes its database, sidecars, and owned directory", () => {
    const repo = makeRepo();
    const receiptFile = path.join(repo, "failure-receipt.json");
    installWalkthroughStub(
      repo,
      `import fs from "node:fs";
const db = process.env.ALLOS_DB_PATH;
for (const file of [db, db + "-wal", db + "-shm"])
  fs.writeFileSync(file, "partial");
fs.writeFileSync(process.env.CENSUS_RECEIPT, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), db,
  routes: process.env.UX_ROUTES,
}));
process.exit(27);
`
    );
    commit(repo, {
      "app/(app)/trends/Chart.tsx": "export const chart = 1;\n",
    });

    const run = runCli(repo, ["HEAD^", "HEAD", "--run"], {
      CENSUS_RECEIPT: receiptFile,
    });
    expect(run.status, run.stderr).toBe(27);
    const receipt = readReceipt(receiptFile);
    expect(receipt).toMatchObject({
      argv: ["--serve", "pages"],
      cwd: fs.realpathSync(repo),
      routes: "/trends",
    });
    expect(fs.existsSync(path.dirname(receipt.db))).toBe(false);
    for (const file of [receipt.db, `${receipt.db}-wal`, `${receipt.db}-shm`])
      expect(fs.existsSync(file)).toBe(false);
  });

  it("gives concurrent census children distinct owned directories and removes both", async () => {
    const repo = makeRepo();
    const receiptDir = path.join(repo, "concurrent-receipts");
    installWalkthroughStub(
      repo,
      `import fs from "node:fs";
import path from "node:path";
const db = process.env.ALLOS_DB_PATH;
fs.writeFileSync(db, "seeded");
fs.mkdirSync(process.env.CENSUS_RECEIPT_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.CENSUS_RECEIPT_DIR, process.pid + ".json"), JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), db,
  routes: process.env.UX_ROUTES,
}));
const deadline = Date.now() + 5000;
while (fs.readdirSync(process.env.CENSUS_RECEIPT_DIR).length < 2 && Date.now() < deadline)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
if (fs.readdirSync(process.env.CENSUS_RECEIPT_DIR).length < 2) process.exit(42);
`
    );
    commit(repo, {
      "app/(app)/trends/Chart.tsx": "export const chart = 1;\n",
    });

    const env = { CENSUS_RECEIPT_DIR: receiptDir };
    const runs = await Promise.all([
      runCliAsync(repo, ["HEAD^", "HEAD", "--run"], env),
      runCliAsync(repo, ["HEAD^", "HEAD", "--run"], env),
    ]);
    expect(
      runs.map((run) => run.status),
      runs.map((run) => run.stderr).join("\n")
    ).toEqual([0, 0]);
    const receipts = fs
      .readdirSync(receiptDir)
      .map((file) => readReceipt(path.join(receiptDir, file)));
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((receipt) => receipt.db)).size).toBe(2);
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        argv: ["--serve", "pages"],
        cwd: fs.realpathSync(repo),
        routes: "/trends",
      });
      expect(fs.existsSync(path.dirname(receipt.db))).toBe(false);
    }
  });
});
