// AN E2E RUN THAT REUSES A BUILD MUST BE ABLE TO PROVE THE BUILD IS THIS TREE'S
// (#5772).
//
// The failure this file exists to keep closed is not a red — it is a GREEN about
// code that was never compiled. `ensureBuild` used to decide by comparing mtimes:
//
//     const builtAt = fs.statSync(BUILD_ID).mtimeMs;
//     stale = newest > builtAt;
//
// #5772 reported that as a same-second coincidence. It is much wider than that, and
// the width was MEASURED on this tree before this file was written:
//
//     next build started            18:38:03
//     app/(auth)/login/page.tsx edited 18:39:43   (+100 s, mid-build)
//     .next/BUILD_ID written        18:41:39   (+217 s)
//
// `BUILD_ID` is stamped at the END of a build that takes minutes, so a source edited
// after the compiler read it but before the build finished carries an mtime 116
// SECONDS BELOW `BUILD_ID` and reads as fresh — permanently, until something else
// touches that file. The bundle from that build contained the pre-edit text and not
// the post-edit text, and the following `npx playwright test` printed no build line
// at all and served the pre-edit paint. The hole is as wide as a build, not as wide
// as a second.
//
// WHAT IS DRIVEN HERE IS THE REAL DECISION PATH, not a model of it:
// `ensureBuild` from e2e/global-setup.ts, over a real tree on disk, spawning a real
// child process through the real `run()` helper. The one substitution is the
// COMPILER: `node_modules/.bin/next` in the fixture root is a stub that does what
// `next build` does in the order that matters — read every build input FIRST, write
// `BUILD_ID` LAST — and records what it read, so "the build being served was
// compiled from source that is no longer in the tree" is a fact this file can
// assert rather than infer. A real `next build` costs ~220 s and belongs to the
// harness, exactly as lib/__tests__/e2e-run-root.test.ts says of its own boundary.
//
// EVERY "REBUILDS" CASE HAS ITS CONVERSE. A staleness check that rebuilds
// unconditionally passes every test above and is useless, so the untouched tree and
// the edited SPEC are asserted to be reused — the cheapness of the suite is the
// property those protect, and it is the one a paranoid fix would quietly destroy.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureBuild } from "../../e2e/global-setup";
import {
  BUILD_RECORD_BASENAME,
  buildFreshnessDecision,
} from "../../e2e/build-inputs.mjs";
import { makeTmpDir } from "./tmp-dir";

// The build inputs the stub compiler "reads", written into .next by it.
const COMPILED_FROM = "compiled-from.json";
// Present in .next between "the compiler has read the sources" and "BUILD_ID is
// written" — the window an editing agent lands in.
const COMPILING = ".compiling";
// Present in the root while a test wants that window held open.
const HOLD = ".stub-hold";

/**
 * `next build`, reduced to the two facts this file is about: it reads the sources
 * at the START, and it stamps BUILD_ID at the END. Everything between is time.
 */
const NEXT_STUB = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.cwd();
const dist = path.join(root, ".next");
const inputs = {};
const walk = (rel) => {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (!st.isDirectory()) {
    inputs[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    return;
  }
  for (const e of fs.readdirSync(abs)) {
    if (e === "node_modules" || e === "__tests__" || e.startsWith(".")) continue;
    walk(path.posix.join(rel, e));
  }
};
for (const d of ["app", "components", "lib", "public"]) walk(d);
for (const f of ["next.config.js", "middleware.ts", "package.json", "package-lock.json", "postcss.config.js", "tsconfig.json"]) walk(f);
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, ${JSON.stringify(COMPILED_FROM)}), JSON.stringify(inputs, null, 2));
fs.writeFileSync(path.join(dist, ${JSON.stringify(COMPILING)}), "");
// Hold the window open while a test edits the tree under the running compiler.
const deadline = Date.now() + 30000;
while (fs.existsSync(path.join(root, ${JSON.stringify(HOLD)})) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
fs.rmSync(path.join(dist, ${JSON.stringify(COMPILING)}), { force: true });
fs.writeFileSync(path.join(dist, "BUILD_ID"), crypto.randomBytes(8).toString("hex"));
`;

const SOURCES: Record<string, string> = {
  "app/page.tsx": "export default function Page() { return null; }\n",
  "components/Card.tsx": 'export const RANK = "button-control-primary";\n',
  "lib/rank.ts": "export const rank = 1;\n",
  "package.json": '{ "name": "fixture" }\n',
  // Neither of these is a build input: a spec is not compiled into the app, and a
  // unit test lives under a NON_BUILD_DIRS name.
  "e2e/thing.spec.ts": "// spec\n",
  "lib/__tests__/thing.test.ts": "// unit test\n",
};

let root: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CI", "E2E_SKIP_BUILD", "E2E_FORCE_BUILD", "E2E_NO_SEED"];

function write(rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

function buildId(): string {
  return read(".next/BUILD_ID");
}

/** What the stub compiler read, keyed by repo-relative path. */
function compiledFrom(): Record<string, string> {
  return JSON.parse(read(path.join(".next", COMPILED_FROM)));
}

/** What the tree holds NOW, in the same terms the stub recorded. */
function hashOf(rel: string): string {
  return crypto.createHash("sha256").update(read(rel)).digest("hex");
}

/** Wait until the stub compiler has read the sources and is mid-build. */
async function untilCompiling(): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (exists(path.join(".next", COMPILING))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the stub compiler never reached its mid-build window");
}

beforeEach(() => {
  root = makeTmpDir("e2e-build-freshness");
  for (const [rel, body] of Object.entries(SOURCES)) write(rel, body);
  write("node_modules/.bin/next", NEXT_STUB);
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // The suite's own environment must not decide these: CI returns before the
  // check runs at all, and a seed would hand this root someone else's build.
  delete process.env.CI;
  delete process.env.E2E_SKIP_BUILD;
  delete process.env.E2E_FORCE_BUILD;
  process.env.E2E_NO_SEED = "1";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ensureBuild over a real tree", () => {
  it("REBUILDS after a source edited WHILE the previous build ran — the mtime rule read that as fresh (#5772)", async () => {
    write(HOLD, "");
    const building = ensureBuild(root);
    await untilCompiling();

    // The agent saves a rendered surface with the compiler already running. This
    // is the whole reproduction: it is an ordinary edit at an ordinary moment.
    write("components/Card.tsx", 'export const RANK = "button-control";\n');
    const editedAt = fs.statSync(
      path.join(root, "components/Card.tsx")
    ).mtimeMs;

    fs.rmSync(path.join(root, HOLD));
    await building;
    const first = buildId();

    // THE HOLE, present in the fixture exactly as it was measured on the repo: the
    // edit is NOT newer than BUILD_ID, so the retired rule's `newest > builtAt` is
    // false and it called this build current. Asserted as the retired rule spelled
    // it — `>=` rather than `>` — because "not newer" is the whole condition, and a
    // tie is a case #5772 reported in its own right.
    const builtAt = fs.statSync(path.join(root, ".next/BUILD_ID")).mtimeMs;
    expect(builtAt).toBeGreaterThanOrEqual(editedAt);

    // …and the build really is the pre-edit one. What is in `.next` was compiled
    // from source that is no longer in the tree.
    expect(compiledFrom()["components/Card.tsx"]).not.toBe(
      hashOf("components/Card.tsx")
    );

    // Read BEFORE the next run, which writes one of its own.
    const racedBuildLeftARecord = exists(
      path.join(".next", BUILD_RECORD_BASENAME)
    );

    // THE REPRODUCTION. The run that follows cannot be served that bundle — this
    // is the assertion that fails on the mtime rule and passes on the fingerprint.
    await ensureBuild(root);
    expect(buildId()).not.toBe(first);
    expect(compiledFrom()["components/Card.tsx"]).toBe(
      hashOf("components/Card.tsx")
    );

    // …and it is not merely that this run happened to rebuild. A record written
    // from the tree AFTER a raced build would have certified the edit INTO a bundle
    // that is missing it, and every later run would have agreed with it. So the
    // raced build wrote no record at all.
    expect(racedBuildLeftARecord).toBe(false);
  });

  it("REBUILDS after an edit stamped with the build's own mtime — the same-second case #5772 reported", async () => {
    await ensureBuild(root);
    const first = buildId();
    const builtAt = fs.statSync(path.join(root, ".next/BUILD_ID")).mtimeMs;

    write("components/Card.tsx", 'export const RANK = "button-control";\n');
    // The reported shape: an edit the mtime comparison cannot see, because the
    // comparison was `>` and these are equal.
    const stamp = new Date(builtAt);
    fs.utimesSync(path.join(root, "components/Card.tsx"), stamp, stamp);

    await ensureBuild(root);
    expect(buildId()).not.toBe(first);
    expect(compiledFrom()["components/Card.tsx"]).toBe(
      hashOf("components/Card.tsx")
    );
  });

  it("REUSES an untouched tree's build, and SAYS it did", async () => {
    await ensureBuild(root);
    const first = buildId();

    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    await ensureBuild(root);
    expect(buildId()).toBe(first);
    expect(said.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "reusing the production build"
    );
  });

  it("REUSES the build after a SPEC or a unit test changed — neither is compiled into the app", async () => {
    await ensureBuild(root);
    const first = buildId();

    // Newer than BUILD_ID by construction, so this is not passing by accident of
    // timing: it passes because neither path is a build input.
    write("e2e/thing.spec.ts", "// edited spec\n");
    write("lib/__tests__/thing.test.ts", "// edited unit test\n");

    await ensureBuild(root);
    expect(buildId()).toBe(first);
  });

  it("REBUILDS when the build carries no record of what it was compiled from", async () => {
    await ensureBuild(root);
    const first = buildId();
    // A `npm run build` outside the harness leaves no record. An unanswerable
    // comparison costs a rebuild; it never counts as a match.
    fs.rmSync(path.join(root, ".next", BUILD_RECORD_BASENAME));

    await ensureBuild(root);
    expect(buildId()).not.toBe(first);
  });

  it("honours both escape hatches: E2E_FORCE_BUILD always builds, E2E_SKIP_BUILD never does", async () => {
    await ensureBuild(root);
    const first = buildId();

    process.env.E2E_FORCE_BUILD = "1";
    await ensureBuild(root);
    const forced = buildId();
    expect(forced).not.toBe(first);

    delete process.env.E2E_FORCE_BUILD;
    process.env.E2E_SKIP_BUILD = "1";
    write("components/Card.tsx", 'export const RANK = "skipped";\n');
    await ensureBuild(root);
    expect(buildId()).toBe(forced);
  });
});

describe("buildFreshnessDecision", () => {
  const tree = "aaaa000000000000";

  it("is fresh only when a record names this tree's inputs", () => {
    expect(
      buildFreshnessDecision({
        hasBuild: true,
        recorded: { fingerprint: tree, fileCount: 3 },
        treeFingerprint: tree,
      }).fresh
    ).toBe(true);
  });

  it("refuses every case it cannot answer, and names which", () => {
    const cases = [
      { hasBuild: false, recorded: null, treeFingerprint: tree },
      { hasBuild: true, recorded: null, treeFingerprint: null },
      { hasBuild: true, recorded: null, treeFingerprint: tree },
      {
        hasBuild: true,
        recorded: { fingerprint: "bbbb000000000000", fileCount: 3 },
        treeFingerprint: tree,
      },
    ];
    for (const facts of cases) {
      const verdict = buildFreshnessDecision(facts);
      expect(verdict.fresh).toBe(false);
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });
});
