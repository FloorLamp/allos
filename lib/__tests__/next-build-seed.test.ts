// Seeding a fresh agent worktree's production build (#2605).
//
// The thing being guarded is not speed. A seed that is wrong hands every browser
// assertion in that worktree a bundle compiled from other sources — green tests
// against code that is not the code, which is strictly worse than the 199-second
// cold build it replaces. So what is asserted here is the REFUSALS, and the one
// fact that licenses a seed at all: identical build inputs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUILD_INPUT_DIRS,
  BUILD_INPUT_FILES,
  BUILD_RECORD_BASENAME,
  buildInputFingerprint,
  newestBuildInputMtime,
  readBuildRecord,
  writeBuildRecord,
} from "../../e2e/build-inputs.mjs";
import {
  discoverSeedSources,
  seedDecision,
  seedNextBuild,
} from "../../e2e/build-seed.mjs";
import {
  EXIT_REFUSED,
  EXIT_SEEDED,
} from "../../scripts/orchestration/seed-next-build.mjs";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const temps: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-seed-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

/** A checkout-shaped tree with one file in each build-input directory. */
function makeCheckout(marker: string): string {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib", "__tests__"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    `export const x = "${marker}";\n`
  );
  fs.writeFileSync(
    path.join(root, "lib", "calc.ts"),
    "export const one = 1;\n"
  );
  fs.writeFileSync(
    path.join(root, "lib", "__tests__", "calc.test.ts"),
    "// spec\n"
  );
  fs.writeFileSync(path.join(root, "docs", "notes.md"), "prose\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
  return root;
}

/** A build-shaped `.next`, with a deterministic low-entropy build id. */
function makeBuild(root: string, buildId: string): string {
  const dist = path.join(root, ".next");
  fs.mkdirSync(path.join(dist, "server"), { recursive: true });
  fs.mkdirSync(path.join(dist, "cache"), { recursive: true });
  fs.writeFileSync(path.join(dist, "BUILD_ID"), `${buildId}\n`);
  fs.writeFileSync(
    path.join(dist, "server", "app.js"),
    `// built ${buildId}\n`
  );
  fs.writeFileSync(path.join(dist, "cache", "compiler.bin"), "cache bytes\n");
  return dist;
}

/**
 * Assert a refusal and hand back its reason.
 *
 * `seedDecision` returns a discriminated union, so `verdict.reason` does not
 * exist until `seed: false` is established. Narrowing through one helper keeps
 * that honest at every call site without five copies of the same guard — and it
 * asserts the refusal, so a verdict that unexpectedly SUCCEEDS fails here rather
 * than reading `undefined` into a `toMatch` that would pass on nothing.
 */
function refusal(verdict: { seed: boolean; reason?: string }): string {
  expect(verdict.seed).toBe(false);
  expect(verdict.reason, "a refusal must carry its reason").toBeTruthy();
  return verdict.reason as string;
}

describe("seedDecision", () => {
  const base = {
    sourceBuildId: "build-one",
    targetHasBuild: false,
    recorded: null as { fingerprint: string } | null,
    sourceFingerprint: "print-a",
    sourceNewestInputMs: 100,
    sourceBuiltAtMs: 200,
    targetFingerprint: "print-a",
  };

  it("seeds on a RECORDED fingerprint that matches the target", () => {
    expect(
      seedDecision({ ...base, recorded: { fingerprint: "print-a" } })
    ).toEqual({ seed: true, proof: "recorded" });
  });

  it("refuses a recorded fingerprint that does not match the target", () => {
    const verdict = seedDecision({
      ...base,
      recorded: { fingerprint: "print-b" },
    });
    expect(refusal(verdict)).toMatch(/different sources/);
  });

  it("refuses when the source has no build to give", () => {
    const verdict = seedDecision({ ...base, sourceBuildId: null });
    expect(refusal(verdict)).toMatch(/no production build/);
  });

  it("refuses rather than overwrite a build the target already has", () => {
    // An agent who has built once owns that build; a seed arriving later would
    // replace their own compiled work with the main checkout's.
    const verdict = seedDecision({ ...base, targetHasBuild: true });
    expect(refusal(verdict)).toMatch(/already has a production build/);
  });

  describe("with no record beside the build", () => {
    it("falls back to deriving, and says so", () => {
      expect(seedDecision(base)).toEqual({ seed: true, proof: "derived" });
    });

    it("refuses when the source build is stale against its own tree", () => {
      // Without a record the only evidence of what `.next` was built from is that
      // nothing under the source has changed since. If something has, the build's
      // provenance is unknown — which is not the same as wrong, and is still a
      // refusal.
      const verdict = seedDecision({ ...base, sourceNewestInputMs: 900 });
      expect(refusal(verdict)).toMatch(/stale/);
    });

    it("refuses when the two trees' build inputs differ", () => {
      const verdict = seedDecision({ ...base, targetFingerprint: "print-b" });
      expect(refusal(verdict)).toMatch(/differ/);
    });
  });
});

describe("buildInputFingerprint", () => {
  it("is equal across two trees with identical build inputs", () => {
    const a = makeCheckout("same");
    const b = makeCheckout("same");
    expect(buildInputFingerprint(a).fingerprint).toBe(
      buildInputFingerprint(b).fingerprint
    );
  });

  it("changes when a build input changes", () => {
    const root = makeCheckout("same");
    const before = buildInputFingerprint(root).fingerprint;
    fs.writeFileSync(
      path.join(root, "lib", "calc.ts"),
      "export const one = 2;\n"
    );
    expect(buildInputFingerprint(root).fingerprint).not.toBe(before);
  });

  it("ignores mtimes — the copy destroys them and they say nothing about bytes", () => {
    const root = makeCheckout("same");
    const before = buildInputFingerprint(root).fingerprint;
    const old = new Date(Date.now() - 86_400_000);
    fs.utimesSync(path.join(root, "lib", "calc.ts"), old, old);
    expect(buildInputFingerprint(root).fingerprint).toBe(before);
  });

  it("ignores what the build does not read — specs and prose", () => {
    const root = makeCheckout("same");
    const before = buildInputFingerprint(root).fingerprint;
    fs.writeFileSync(
      path.join(root, "lib", "__tests__", "calc.test.ts"),
      "// edited spec\n"
    );
    fs.writeFileSync(path.join(root, "docs", "notes.md"), "edited prose\n");
    expect(buildInputFingerprint(root).fingerprint).toBe(before);
  });

  it("sees a DELETED build input through the directory mtime too", () => {
    // A deletion changes no surviving file's mtime, which is the hole a file-only
    // walk cannot see. The fingerprint catches it by content; the mtime walk has
    // to catch it as well, because it is the fallback proof's only evidence.
    const root = makeCheckout("same");
    const before = buildInputFingerprint(root).fingerprint;
    const long_ago = new Date(Date.now() - 86_400_000);
    for (const rel of [
      "app",
      "app/page.tsx",
      "lib",
      "lib/calc.ts",
      "package.json",
    ]) {
      fs.utimesSync(path.join(root, rel), long_ago, long_ago);
    }
    const quiet = newestBuildInputMtime(root).ms;
    fs.rmSync(path.join(root, "lib", "calc.ts"));
    expect(buildInputFingerprint(root).fingerprint).not.toBe(before);
    expect(newestBuildInputMtime(root).ms).toBeGreaterThan(quiet);
  });
});

describe("the build record", () => {
  it("round-trips the fingerprint of the tree that produced the build", () => {
    const root = makeCheckout("same");
    const dist = makeBuild(root, "build-one");
    const written = writeBuildRecord(root, dist);
    expect(written.fingerprint).toBe(buildInputFingerprint(root).fingerprint);
    expect(readBuildRecord(dist)?.fingerprint).toBe(written.fingerprint);
  });

  it("is ignored once it names a build id the dist dir no longer serves", () => {
    // `next build` is not guaranteed to remove files it did not write, so a record
    // can outlive the build it described. A record that survives a rebuild is
    // precisely the stale proof that would authorize seeding the wrong bundle.
    const root = makeCheckout("same");
    const dist = makeBuild(root, "build-one");
    writeBuildRecord(root, dist);
    fs.writeFileSync(path.join(dist, "BUILD_ID"), "build-two\n");
    expect(readBuildRecord(dist)).toBeNull();
  });

  it("is ignored when written by another algorithm version", () => {
    const root = makeCheckout("same");
    const dist = makeBuild(root, "build-one");
    writeBuildRecord(root, dist);
    const file = path.join(dist, BUILD_RECORD_BASENAME);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      JSON.stringify({ ...parsed, algo: "allos-build-inputs-v0" })
    );
    expect(readBuildRecord(dist)).toBeNull();
  });
});

describe("seedNextBuild", () => {
  it("copies the build, owns its inodes, and stamps BUILD_ID forward", () => {
    const from = makeCheckout("same");
    const to = makeCheckout("same");
    const sourceDist = makeBuild(from, "build-one");
    writeBuildRecord(from, sourceDist);
    // The source build is deliberately older than the target's freshly written
    // sources — the situation `git worktree add` always produces, and the reason
    // an unstamped seed would be rebuilt immediately.
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(sourceDist, "BUILD_ID"), old, old);

    const result = seedNextBuild({ from, to });
    expect(result).toMatchObject({ seed: true, proof: "recorded" });

    const seededBuildId = path.join(to, ".next", "BUILD_ID");
    expect(fs.readFileSync(seededBuildId, "utf8").trim()).toBe("build-one");
    expect(
      fs.readFileSync(path.join(to, ".next", "server", "app.js"), "utf8")
    ).toBe("// built build-one\n");
    // Not a hard link: writing through into the main checkout is the trap this
    // whole path has to avoid.
    expect(fs.statSync(seededBuildId).nlink).toBe(1);
    expect(fs.statSync(seededBuildId).ino).not.toBe(
      fs.statSync(path.join(sourceDist, "BUILD_ID")).ino
    );
    // Newer than every source file in the target, so `ensureBuild` accepts it.
    expect(fs.statSync(seededBuildId).mtimeMs).toBeGreaterThan(
      newestBuildInputMtime(to).ms
    );
    expect(readBuildRecord(path.join(to, ".next"))?.seededFrom).toBe(from);
    // The compiler cache is two thirds of the bytes and buys nothing in a
    // differently-named directory — measured at 289 s to rebuild with it against
    // 199 s cold. It is not carried.
    expect(fs.existsSync(path.join(to, ".next", "cache"))).toBe(false);
  });

  it("refuses, and leaves no `.next` at all, when the sources differ", () => {
    const from = makeCheckout("source-only");
    const to = makeCheckout("target-only");
    writeBuildRecord(from, makeBuild(from, "build-one"));

    const result = seedNextBuild({ from, to });
    expect(result.seed).toBe(false);
    expect(result.attempts[0].reason).toMatch(/different sources/);
    // Neither the dist dir nor the temp dir the copy stages into: a half-seeded
    // worktree would boot `next start` against an incomplete bundle.
    expect(fs.readdirSync(to).filter((e) => e.startsWith(".next"))).toEqual([]);
  });

  it("refuses without a record when the source build is stale against its tree", () => {
    const from = makeCheckout("same");
    const to = makeCheckout("same");
    makeBuild(from, "build-one");
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(from, ".next", "BUILD_ID"), old, old);

    const result = seedNextBuild({ from, to });
    expect(result.seed).toBe(false);
    expect(result.attempts[0].reason).toMatch(/stale/);
    expect(fs.readdirSync(to).filter((e) => e.startsWith(".next"))).toEqual([]);
  });

  it("refuses rather than replace a build this worktree already made", () => {
    const from = makeCheckout("same");
    const to = makeCheckout("same");
    writeBuildRecord(from, makeBuild(from, "build-one"));
    makeBuild(to, "build-mine");

    const result = seedNextBuild({ from, to });
    expect(result.seed).toBe(false);
    expect(result.attempts[0].reason).toMatch(/already has a production build/);
    expect(
      fs.readFileSync(path.join(to, ".next", "BUILD_ID"), "utf8").trim()
    ).toBe("build-mine");
  });

  it("never offers the target itself as a source", () => {
    // Discovery walks `git worktree list`, which includes the caller.
    expect(discoverSeedSources(REPO)).not.toContain(REPO);
  });

  it("exposes refusal as its own exit code, distinct from an error", () => {
    // Callers must be able to accept a refusal without treating it as a failure —
    // and must never read one as a success.
    expect(EXIT_SEEDED).toBe(0);
    expect(EXIT_REFUSED).toBe(3);
  });
});

describe("the declaration has one home", () => {
  it("is not re-declared in e2e/global-setup.ts", () => {
    // Two copies of an invalidation rule is the shape that fails silently: the
    // copy that is wrong does not throw, it authorizes a stale bundle.
    const src = fs.readFileSync(path.join(REPO, "e2e/global-setup.ts"), "utf8");
    expect(src).toMatch(/from "\.\/build-inputs\.mjs"/);
    expect(src).not.toMatch(/const BUILD_INPUT_DIRS\s*=/);
    expect(src).not.toMatch(/const NON_BUILD_DIRS\s*=/);
  });

  it("still describes the repository it is declared against", () => {
    // A build-input directory that stops existing is a declaration nobody updated.
    for (const dir of BUILD_INPUT_DIRS) {
      expect(fs.existsSync(path.join(REPO, dir)), dir).toBe(true);
    }
    for (const file of BUILD_INPUT_FILES) {
      expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
    }
  });

  it("fingerprints this repository without reading node_modules", () => {
    const started = Date.now();
    const print = buildInputFingerprint(REPO);
    expect(print.fileCount).toBeGreaterThan(100);
    expect(print.fingerprint).toHaveLength(64);
    // The seed must stay cheap against the build it replaces; a fingerprint that
    // wandered into node_modules would cost more than it saves.
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
