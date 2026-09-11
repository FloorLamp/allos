import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { perTestCeiling } from "../../vitest.timeouts";
import { makeTmpDir } from "./tmp-dir";
import {
  cleanupOnExit,
  containsHead,
  prepareHeadTree,
  reachVerdict,
  sweepStaleWalkTrees,
  WALK_DIR_PREFIX,
} from "../../scripts/orchestration/merge-gate-core.mjs";

// WALKING THE PR HEAD WHEN THE CHECKOUT IS NOT IT (#5710, part 2 of #5715).
//
// The merge gate's reach row spawns `scripts/reach.ts` against the tree it runs
// in, and `scripts/reach-graph.ts` binds its ROOT to the tree the WALKER sits
// in — so the tree is chosen by the child's cwd. Under CI that tree is the
// merge commit and a symbol the PR adds resolves; from a `main` checkout it does
// not exist, and #5743's decline is all the reader gets.
//
// THE CASE ONLY EXISTS WHEN TWO TREES DIFFER, so every fixture here is a real
// git repository: an origin holding a base commit WITHOUT the symbol and a head
// commit WITH it, a stale checkout at the base, and — because the CI path must
// stay exactly as it was — a replica of what `actions/checkout@v7` leaves behind
// on a `pull_request` event, which is `refs/pull/N/merge` fetched at depth 1.
//
// AND BOTH WAYS, because a test that only proved the answer would hide the
// failure this row must keep making: when the head genuinely cannot be fetched,
// the row still declines and says why. The walker in the control tests is the
// REAL `scripts/reach.ts`, spawned the way merge-gate.mjs spawns it.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WALK_MS = perTestCeiling(2, "green"); // ~1.2 s observed per walk, 2026-09-10

/** git, with an identity of its own so no global config is required. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "user.name=fixture",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

const write = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

const BASE_X = "export function baseOnly() {\n  return 1;\n}\n";
const HEAD_X = `${BASE_X}export function addedByPr() {\n  return 2;\n}\n`;
const BASE_PAGE =
  'import { baseOnly } from "../lib/x";\n' +
  "export default function Page() {\n  return baseOnly();\n}\n";
const HEAD_PAGE =
  'import { addedByPr, baseOnly } from "../lib/x";\n' +
  "export default function Page() {\n  return addedByPr() + baseOnly();\n}\n";

// The patch the gate would read from `GET /pulls/N/files` for that head commit:
// one added declaration, so `changedDerivations` yields exactly `addedByPr`.
const PR_FILES = [
  {
    filename: "lib/x.ts",
    status: "modified",
    patch: [
      "@@ -1,3 +1,6 @@",
      " export function baseOnly() {",
      "   return 1;",
      " }",
      "+export function addedByPr() {",
      "+  return 2;",
      "+}",
    ].join("\n"),
  },
];

type Fixture = {
  root: string;
  origin: string;
  stale: string;
  ci: string;
  atHead: string;
  stateDir: string;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  staleSha: string;
};

let fx: Fixture;

/**
 * An origin whose PR ref holds a symbol its base does not, plus the three
 * checkouts the gate can find itself in: stale (a `main` checkout), the CI
 * merge checkout, and the head itself.
 *
 * `scripts/reach.ts` and `scripts/reach-graph.ts` are copied in so the REAL
 * walker can run here, and `components/` exists because the walker's file
 * census reads all three source roots.
 */
beforeAll(() => {
  const root = makeTmpDir("reach-head-walk");
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main", ".");
  fs.mkdirSync(path.join(origin, "scripts"), { recursive: true });
  for (const f of ["scripts/reach.ts", "scripts/reach-graph.ts"])
    fs.copyFileSync(path.join(REPO, f), path.join(origin, f));
  write(origin, "components/keep.ts", "export const KEEP = 1;\n");
  write(origin, "lib/x.ts", BASE_X);
  write(origin, "app/page.tsx", BASE_PAGE);
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "base");
  const baseSha = git(origin, "rev-parse", "HEAD");

  git(origin, "checkout", "-q", "-b", "pr");
  write(origin, "lib/x.ts", HEAD_X);
  write(origin, "app/page.tsx", HEAD_PAGE);
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "the PR head");
  const headSha = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/head", headSha);

  // main moves on, so the merge of the PR is a real merge commit — the shape
  // CI checks out — and the stale checkout is genuinely behind.
  git(origin, "checkout", "-q", "main");
  write(origin, "lib/unrelated.ts", "export const UNRELATED = 1;\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "main moves");
  git(origin, "merge", "-q", "--no-ff", "-m", "merge pr", "pr");
  const mergeSha = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/merge", mergeSha);
  git(origin, "reset", "-q", "--hard", "HEAD~1");
  const staleSha = git(origin, "rev-parse", "HEAD");

  const stale = path.join(root, "stale");
  git(root, "clone", "-q", origin, stale);

  // What actions/checkout@v7 leaves on a pull_request event.
  const ci = path.join(root, "ci");
  fs.mkdirSync(ci);
  git(ci, "init", "-q", ".");
  git(
    ci,
    "fetch",
    "-q",
    "--depth=1",
    "--no-tags",
    origin,
    "+refs/pull/7/merge:refs/remotes/pull/7/merge"
  );
  git(ci, "checkout", "-q", "--detach", "refs/remotes/pull/7/merge");

  const atHead = path.join(root, "at-head");
  git(root, "clone", "-q", "-b", "pr", origin, atHead);

  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
  fx = {
    root,
    origin,
    stale,
    ci,
    atHead,
    stateDir,
    baseSha,
    headSha,
    mergeSha,
    staleSha,
  };
});

/** merge-gate.mjs's own child walker, verbatim in shape: the tree is the cwd. */
const walkerIn = (cwd: string) => (file: string, symbol: string) => {
  const run = spawnSync(
    "npx",
    ["tsx", "scripts/reach.ts", file, symbol, "--json"],
    { cwd, encoding: "utf8", timeout: 60_000 }
  );
  if (run.error) throw new Error(run.error.message);
  if (run.status !== 0)
    throw new Error((run.stderr ?? "").trim() || `exit ${run.status}`);
  return JSON.parse(run.stdout);
};

const linkModules = (dir: string) => {
  const link = path.join(dir, "node_modules");
  if (!fs.existsSync(link))
    fs.symlinkSync(path.join(REPO, "node_modules"), link, "dir");
};

const walkDirs = (dir: string) =>
  fs.readdirSync(dir).filter((n) => n.startsWith(WALK_DIR_PREFIX));

describe("containsHead — which trees already ARE the PR", () => {
  it("says a checkout of the head itself is", () => {
    expect(containsHead({ repoRoot: fx.atHead, head: fx.headSha })).toEqual({
      contained: true,
      walkedOn: fx.headSha,
      how: "this checkout IS the PR head",
    });
  });

  // THE CI PATH, AND THE REASON THE PARENT-LINE READ EXISTS. In the depth-1
  // merge checkout the head is not even an object, so ancestry cannot answer;
  // the raw commit still lists both parents. Without this branch every CI run
  // would decide it was stale and go to the network.
  it("says the CI wrapper's shallow merge checkout is, though the head object is absent", () => {
    expect(
      spawnSync("git", ["cat-file", "-e", fx.headSha], { cwd: fx.ci }).status
    ).not.toBe(0);
    expect(
      spawnSync("git", ["merge-base", "--is-ancestor", fx.headSha, "HEAD"], {
        cwd: fx.ci,
      }).status
    ).not.toBe(0);
    expect(containsHead({ repoRoot: fx.ci, head: fx.headSha })).toEqual({
      contained: true,
      walkedOn: fx.mergeSha,
      how: "this checkout is a merge commit whose parent is the PR head",
    });
  });

  it("says a stale checkout is not, and names what it is on", () => {
    const verdict = containsHead({ repoRoot: fx.stale, head: fx.headSha });
    expect(verdict.contained).toBe(false);
    expect(verdict.walkedOn).toBe(fx.staleSha);
    expect(verdict.how).toBe(
      `this checkout is on ${fx.staleSha.slice(0, 8)}, not the PR head`
    );
  });
});

describe("prepareHeadTree", () => {
  it("fetches the head into a tree under the state dir, and cleans it up", () => {
    const before = walkDirs(fx.stateDir).length;
    const refsBefore = git(fx.stale, "for-each-ref");
    const objectsBefore = git(fx.stale, "count-objects", "-v");
    const prepared = prepareHeadTree({
      repoRoot: fx.stale,
      head: fx.headSha,
      stateDir: fx.stateDir,
      refs: [`+refs/pull/7/head:refs/reach/head`],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(path.dirname(prepared.dir)).toBe(fx.stateDir);
    expect(path.basename(prepared.dir).startsWith(WALK_DIR_PREFIX)).toBe(true);
    expect(git(prepared.dir, "rev-parse", "HEAD")).toBe(fx.headSha);
    expect(fs.readFileSync(path.join(prepared.dir, "lib/x.ts"), "utf8")).toBe(
      HEAD_X
    );
    // THE CHECKOUT IT BORROWED FROM IS UNTOUCHED — the rule that rules out
    // `git worktree add` (which registers metadata there) and a fetch into it
    // (which writes objects). Refs, object counts, HEAD and the worktree list
    // all read exactly as they did before.
    expect(git(fx.stale, "rev-parse", "HEAD")).toBe(fx.staleSha);
    expect(git(fx.stale, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(fx.stale, "for-each-ref")).toBe(refsBefore);
    expect(git(fx.stale, "count-objects", "-v")).toBe(objectsBefore);

    prepared.cleanup();
    expect(fs.existsSync(prepared.dir)).toBe(false);
    expect(walkDirs(fx.stateDir).length).toBe(before);
    expect(() => prepared.cleanup()).not.toThrow(); // idempotent
  });

  it("links node_modules in, so the walker's own tsx can start", () => {
    linkModules(fx.stale);
    const prepared = prepareHeadTree({
      repoRoot: fx.stale,
      head: fx.headSha,
      stateDir: fx.stateDir,
      refs: [`+refs/pull/7/head:refs/reach/head`],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const link = path.join(prepared.dir, "node_modules");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(path.join(fx.stale, "node_modules"));
    prepared.cleanup();
    // rmSync unlinks the link; what it pointed at survives.
    expect(fs.existsSync(path.join(REPO, "node_modules"))).toBe(true);
    expect(fs.existsSync(path.join(fx.stale, "node_modules"))).toBe(true);
  });

  it("declines, and strands nothing, when the ref cannot be fetched", () => {
    const before = walkDirs(fx.stateDir).length;
    const prepared = prepareHeadTree({
      repoRoot: fx.stale,
      head: fx.headSha,
      stateDir: fx.stateDir,
      refs: ["+refs/pull/999/head:refs/reach/head"],
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toContain(
      `could not fetch the PR head ${fx.headSha.slice(0, 8)}`
    );
    expect(prepared.reason).toContain("couldn't find remote ref");
    expect(walkDirs(fx.stateDir).length).toBe(before);
  });

  it("declines when the head moved out from under the fetched ref", () => {
    const gone = "0".repeat(40);
    const prepared = prepareHeadTree({
      repoRoot: fx.stale,
      head: gone,
      stateDir: fx.stateDir,
      refs: ["+refs/pull/7/head:refs/reach/head"],
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toContain("may have moved since this gate read it");
    expect(walkDirs(fx.stateDir)).toEqual([]);
  });

  it("refuses to fetch a PR number from a different repository", () => {
    const prepared = prepareHeadTree({
      repoRoot: fx.stale,
      head: fx.headSha,
      stateDir: fx.stateDir,
      expectRepo: "FloorLamp/allos",
      refs: ["+refs/pull/7/head:refs/reach/head"],
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toContain("refusing to fetch");
    expect(prepared.reason).toContain("FloorLamp/allos");
    expect(walkDirs(fx.stateDir)).toEqual([]);
  });

  it("declines when there is no origin to fetch from", () => {
    const bare = path.join(fx.root, "no-origin");
    fs.mkdirSync(bare);
    git(bare, "init", "-q", ".");
    const prepared = prepareHeadTree({
      repoRoot: bare,
      head: fx.headSha,
      stateDir: fx.stateDir,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toContain("no origin remote");
  });

  it("declines, naming the errno, when the state dir cannot take a directory", () => {
    const full = Object.assign(Object.create(fs), {
      mkdirSync: () => undefined,
      mkdtempSync: () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      },
    });
    const prepared = prepareHeadTree({
      repoRoot: fx.stale,
      head: fx.headSha,
      stateDir: fx.stateDir,
      io: full,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).toContain("could not make a temporary worktree");
    expect(prepared.reason).toContain("ENOSPC");
  });

  // NO CREDENTIAL-SHAPED LITERAL IN THIS FILE, and the planted value is built
  // at runtime so that none can be. The secret scanner matches SHAPE, not
  // meaning: a token-shaped string that spells out in its own characters that
  // it is a fixture still reds `github-pat` (it did, on this file's first
  // commit), and the scan reads COMMITS rather than tips, so such a literal is
  // not undone by a later commit deleting it.
  //
  // A synthetic body is not a weaker test here, it is a truer one: `redactUrls`
  // keys on the `//userinfo@host` SHAPE — two slashes, then anything that is
  // not `/`, `@` or whitespace, then `@` — and never on a token's alphabet or
  // entropy. What must be proved is that whatever sits in the userinfo position
  // does not reach the row, so the fixture is better for looking nothing like a
  // credential: it cannot drift back toward one.
  it("never prints a credential the remote URL carries", () => {
    const planted = ["fixture", "userinfo", "body"].join("-");
    const url = `https://x-access-token:${planted}@github.com/o/r.git`;
    const prepared = prepareHeadTree({
      repoRoot: fx.stale,
      head: fx.headSha,
      stateDir: fx.stateDir,
      expectRepo: "o/r",
      refs: ["+refs/pull/7/head:refs/reach/head"],
      git: (args: string[]) =>
        args[0] === "remote"
          ? { status: 0, stdout: `${url}\n`, stderr: "" }
          : args[0] === "fetch"
            ? {
                status: 128,
                stdout: "",
                stderr: `fatal: unable to access '${url}': 403\n`,
              }
            : { status: 0, stdout: "", stderr: "" },
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason).not.toContain(planted);
    expect(prepared.reason).toContain("<redacted>@github.com");
    // The URL still reached the reason, so the absence above is redaction and
    // not a reason that simply never quoted the remote.
    expect(prepared.reason).toContain("github.com/o/r.git");
  });
});

describe("what an interrupt leaves behind", () => {
  it("cleans up on exit and on a signal, and stops listening when released", () => {
    const listeners: Record<string, Array<() => void>> = {};
    let exited: number | null = null;
    const proc = {
      on: (event: string, handler: () => void) => {
        (listeners[event] ??= []).push(handler);
      },
      removeListener: (event: string, handler: () => void) => {
        listeners[event] = (listeners[event] ?? []).filter(
          (h) => h !== handler
        );
      },
      exit: (code: number) => {
        exited = code;
      },
    };
    let cleaned = 0;
    const release = cleanupOnExit(() => cleaned++, proc);
    expect(Object.keys(listeners).sort()).toEqual([
      "SIGINT",
      "SIGTERM",
      "exit",
    ]);
    listeners.SIGINT[0]();
    expect(cleaned).toBe(1);
    expect(exited).toBe(130);
    listeners.exit[0]();
    expect(cleaned).toBe(2);
    release();
    expect(listeners.exit).toEqual([]);
    expect(listeners.SIGINT).toEqual([]);
    expect(listeners.SIGTERM).toEqual([]);
  });

  // The SIGKILL residue: nothing runs, so the reclaim has to be at creation.
  it("sweeps an abandoned tree older than the window, and only that", () => {
    const dir = makeTmpDir("reach-head-sweep");
    const stale = path.join(dir, `${WALK_DIR_PREFIX}killed`);
    const fresh = path.join(dir, `${WALK_DIR_PREFIX}running`);
    const foreign = path.join(dir, "wt-another-lane");
    for (const d of [stale, fresh, foreign]) fs.mkdirSync(d);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(foreign, old, old);
    expect(sweepStaleWalkTrees(dir)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    // The positive control on the guard: an OLD directory that is not ours,
    // and a NEW one that is, both survive.
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe("the row, both ways, with the real walker", () => {
  it(
    "declines on the stale checkout and ANSWERS on the fetched head",
    () => {
      linkModules(fx.stale);
      const stale = walkerIn(fx.stale);

      // One: the walked tree genuinely cannot answer — this is the bug.
      expect(() => stale("lib/x.ts", "addedByPr")).toThrow(
        /declares no top-level `addedByPr`/
      );
      const before = reachVerdict({
        files: PR_FILES,
        body: "",
        reachFn: stale,
        walkedOn: fx.staleSha,
      });
      expect(before).toEqual([
        `reach — could not answer for addedByPr (walked on ${fx.staleSha.slice(0, 8)}): ` +
          "lib/x.ts declares no top-level `addedByPr`; it has: baseOnly; " +
          "addedByPr is added by this PR and is not on the walked tree; " +
          "resolve on the PR head or merge tree",
      ]);

      // Two: the same PR, the same stale checkout, with the head fetched.
      const prepared = prepareHeadTree({
        repoRoot: fx.stale,
        head: fx.headSha,
        stateDir: fx.stateDir,
        refs: [`+refs/pull/7/head:refs/reach/head`],
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      try {
        const after = reachVerdict({
          files: PR_FILES,
          body: "",
          reachFn: stale,
          walkedOn: fx.staleSha,
          retryFn: walkerIn(prepared.dir),
          retryOn: fx.headSha,
        });
        expect(after).toEqual([
          `reach — addedByPr (lib/x.ts) reaches 1 terminal(s) on the PR head ` +
            `${fx.headSha.slice(0, 8)}; no consumer table in the body ` +
            "(advisory): app/page.tsx",
        ]);
      } finally {
        prepared.cleanup();
      }
      expect(walkDirs(fx.stateDir)).toEqual([]);
    },
    WALK_MS * 3
  );

  it(
    "keeps declining — and says why — when the head cannot be fetched",
    () => {
      linkModules(fx.stale);
      const failed = prepareHeadTree({
        repoRoot: fx.stale,
        head: fx.headSha,
        stateDir: fx.stateDir,
        refs: ["+refs/pull/999/head:refs/reach/head"],
      });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      const rows = reachVerdict({
        files: PR_FILES,
        body: "",
        reachFn: walkerIn(fx.stale),
        walkedOn: fx.staleSha,
        // What merge-gate.mjs does with a refusal: rethrow it into the row.
        retryFn: () => {
          throw new Error(failed.reason);
        },
        retryOn: fx.headSha,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("could not answer for addedByPr");
      expect(rows[0]).toContain(`(walked on ${fx.staleSha.slice(0, 8)})`);
      expect(rows[0]).toContain(
        `nor on the PR head ${fx.headSha.slice(0, 8)}: could not fetch the PR head`
      );
      expect(rows[0]).toContain("couldn't find remote ref");
      // The thing this whole test exists to forbid: no row here reads clean.
      expect(rows[0]).not.toContain("reaches");
    },
    WALK_MS * 2
  );

  it("says one reason once when both trees fail the same way", () => {
    const broken = () => {
      throw new Error("Unterminated string in JSON at position 146176");
    };
    expect(
      reachVerdict({
        files: PR_FILES,
        body: "",
        reachFn: broken,
        walkedOn: fx.staleSha,
        retryFn: broken,
        retryOn: fx.headSha,
      })
    ).toEqual([
      `reach — could not answer for addedByPr (walked on ${fx.staleSha.slice(0, 8)}) ` +
        `or on the PR head ${fx.headSha.slice(0, 8)}: ` +
        "Unterminated string in JSON at position 146176",
    ]);
  });

  it(
    "never fetches when the tree in hand already holds the symbol",
    () => {
      linkModules(fx.atHead);
      let retried = 0;
      const rows = reachVerdict({
        files: PR_FILES,
        body: "",
        reachFn: walkerIn(fx.atHead),
        walkedOn: fx.headSha,
        retryFn: () => {
          retried++;
          throw new Error("the head was fetched, and it should not have been");
        },
        retryOn: fx.headSha,
      });
      expect(retried).toBe(0);
      // An answer from the tree in hand names no tree — #5709's shape, unchanged.
      expect(rows).toEqual([
        "reach — addedByPr (lib/x.ts) reaches 1 terminal(s); no consumer " +
          "table in the body (advisory): app/page.tsx",
      ]);
    },
    WALK_MS * 2
  );
});
