import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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

// Seed Git and the child-process stub once, then copy that immutable baseline into
// each case. Every case still makes its own real commit and crosses the real CLI
// boundary without paying for identical repository setup again.
let repoTemplate: string;

function makeRepo(): string {
  const root = makeTmpDir("post-merge-census-cli");
  const repo = path.join(root, "repo");
  fs.cpSync(repoTemplate, repo, { recursive: true });
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

interface ChildReceipt {
  argv: string[];
  cwd: string;
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

beforeAll(() => {
  repoTemplate = makeTmpDir("post-merge-census-template");
  git(repoTemplate, ["init", "-q"]);
  git(repoTemplate, ["config", "user.email", "census@example.test"]);
  git(repoTemplate, ["config", "user.name", "Census Test"]);
  write(repoTemplate, "app/(app)/page.tsx");
  write(repoTemplate, "app/(app)/trends/page.tsx");
  write(repoTemplate, "app/(app)/nutrition/page.tsx");
  write(
    repoTemplate,
    "scripts/ux-walkthrough.mjs",
    `import fs from "node:fs";
fs.writeFileSync(process.env.CENSUS_RECEIPT, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(),
  routes: process.env.UX_ROUTES, seed: process.env.UX_SEED,
  rng: process.env.SEED_RNG, persona: process.env.SEED_PERSONA,
}));
if (process.env.CENSUS_EXIT) process.exit(Number(process.env.CENSUS_EXIT));
`
  );
  git(repoTemplate, ["add", "."]);
  git(repoTemplate, ["commit", "-qm", "baseline"]);
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
  it("does not under-scope a mixed app + shared runtime diff", () => {
    const repo = makeRepo();
    commit(repo, {
      "app/(app)/trends/Chart.tsx": "export const chart = 1;\n",
      "lib/nav.ts": "export const shared = 1;\n",
    });

    const run = runCli(repo, ["HEAD^", "HEAD"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("post-merge census: full (all)");
    expect(run.stdout).toContain("unmapped runtime/shared files changed");
    expect(run.stdout).not.toContain("UX_ROUTES=/trends");
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
      commit(repo, {
        [changedFile]: "export const changed = 1;\n",
      });

      const run = runCli(repo, ["HEAD^", "HEAD", "--run"], {
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
    }
  );

  it("prints an executable plan that safely preserves the requested shape", () => {
    const repo = makeRepo();
    const receiptFile = path.join(repo, "shape-receipt.json");
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

  it("propagates child failure", () => {
    const repo = makeRepo();
    const receiptFile = path.join(repo, "failure-receipt.json");
    commit(repo, {
      "app/(app)/trends/Chart.tsx": "export const chart = 1;\n",
    });

    const run = runCli(repo, ["HEAD^", "HEAD", "--run"], {
      CENSUS_RECEIPT: receiptFile,
      CENSUS_EXIT: "27",
    });
    expect(run.status, run.stderr).toBe(27);
    const receipt = readReceipt(receiptFile);
    expect(receipt).toMatchObject({
      argv: ["--serve", "pages"],
      cwd: fs.realpathSync(repo),
      routes: "/trends",
    });
  });
});
