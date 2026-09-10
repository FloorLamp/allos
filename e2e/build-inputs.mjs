// What the production build READS, and the fingerprint over it (#2605).
//
// `ensureBuild` (e2e/global-setup.ts) has always owned this declaration. It used to
// ask "is `.next` older than any source the build compiled"; since #5772 it asks
// "was `.next` compiled from the sources this tree holds", because the older,
// timestamp-shaped question cannot see an edit made while the build itself was
// running. The seeding step in scripts/orchestration/seed-next-build.mjs asks that
// same question of ANOTHER tree's build — "would a build of THIS tree produce the
// bytes already sitting in THAT tree" — so the declaration moved here rather than
// being copied. Two copies of an invalidation rule is the one shape that fails
// silently: the copy that is wrong does not throw, it serves a stale bundle.
//
// It lives under `e2e/` and not under `scripts/orchestration/` on purpose. The CI
// no-runtime-surface skip set claims nothing in the app or the e2e harness imports
// `scripts/orchestration/`; global-setup importing from there would falsify that
// claim and silently drop the browser matrix for a change that needs it.
//
// A `.mjs` because both consumers must load it: TypeScript under Playwright's
// transform (tsconfig has `allowJs`), and plain `node` with no loader at all.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Directories whose contents the production build compiles. */
export const BUILD_INPUT_DIRS = ["app", "components", "lib", "public"];

/** Individual files whose change invalidates the production build. */
export const BUILD_INPUT_FILES = [
  "next.config.js",
  "middleware.ts",
  "package.json",
  "package-lock.json",
  "postcss.config.js",
  "tsconfig.json",
];

/**
 * Directories under a build-input dir that the BUILD does not read — editing a
 * test must never cost a rebuild, and must never block a seed.
 */
export const NON_BUILD_DIRS = new Set([
  "node_modules",
  "__tests__",
  "__db_tests__",
  "__action_tests__",
]);

/**
 * Bumped whenever the walk, the hash composition, or the declaration above
 * changes. A record written by an older algorithm is not compared, it is
 * ignored — an unreadable proof is no proof.
 */
export const FINGERPRINT_ALGO = "allos-build-inputs-v1";

/** Where the fingerprint of a build's inputs is recorded, inside the dist dir. */
export const BUILD_RECORD_BASENAME = "allos-build-inputs.json";

function walkInto(abs, rel, out) {
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    out.push(rel);
    return;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (NON_BUILD_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    walkInto(path.join(abs, entry.name), `${rel}/${entry.name}`, out);
  }
}

/** Every build-input FILE under `root`, as sorted repo-relative POSIX paths. */
export function listBuildInputs(root) {
  const out = [];
  for (const dir of BUILD_INPUT_DIRS) walkInto(path.join(root, dir), dir, out);
  for (const file of BUILD_INPUT_FILES) {
    if (fs.existsSync(path.join(root, file))) out.push(file);
  }
  return out.sort();
}

/**
 * The newest mtime across the build inputs, and the path carrying it.
 *
 * ITS ONE READER IS `seedDecision`'s DERIVED BRANCH (./build-seed.mjs) — the only
 * evidence available about a source build that carries no input record. Since
 * #5772 `ensureBuild` compares fingerprints and reads no mtime at all, so nothing
 * about LOCAL staleness comes through here any more.
 *
 * DIRECTORIES COUNT HERE, which is what makes it more than a cheap cousin of
 * `buildInputFingerprint`. Deleting a source file changes no surviving file's
 * mtime, only its parent directory's — so a file-only walk cannot see a deletion
 * and would call a build current that no longer matches the tree, which for a SEED
 * would ship one worktree's bundle into another. (A fingerprint sees a deletion
 * with no help at all: the file simply leaves the list.)
 */
export function newestBuildInputMtime(root) {
  let newestMs = 0;
  let newestPath = null;
  const consider = (abs, rel) => {
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (stat.mtimeMs > newestMs) {
      newestMs = stat.mtimeMs;
      newestPath = rel;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (NON_BUILD_DIRS.has(entry.name) || entry.name.startsWith("."))
        continue;
      consider(path.join(abs, entry.name), `${rel}/${entry.name}`);
    }
  };
  for (const dir of BUILD_INPUT_DIRS) consider(path.join(root, dir), dir);
  for (const file of BUILD_INPUT_FILES) consider(path.join(root, file), file);
  return { ms: newestMs, path: newestPath };
}

/**
 * A content hash over every build input of `root`.
 *
 * CONTENT ONLY — never mtimes, never inodes. Both are destroyed by the copy this
 * fingerprint exists to authorize, and neither says anything about the bytes the
 * compiler would read. The declaration itself is folded in, so widening
 * `BUILD_INPUT_DIRS` invalidates every record written under the old one.
 *
 * @typedef {{ algo: string, fingerprint: string, fileCount: number,
 *             bytes: number }} BuildInputFingerprint
 * @returns {BuildInputFingerprint}
 */
export function buildInputFingerprint(root) {
  const files = listBuildInputs(root);
  const hash = crypto.createHash("sha256");
  hash.update(FINGERPRINT_ALGO);
  hash.update("\0dirs:" + BUILD_INPUT_DIRS.join(","));
  hash.update("\0files:" + BUILD_INPUT_FILES.join(","));
  hash.update("\0skip:" + [...NON_BUILD_DIRS].sort().join(","));
  let bytes = 0;
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(root, rel));
    bytes += buf.length;
    hash.update("\0" + rel + "\0");
    hash.update(crypto.createHash("sha256").update(buf).digest());
  }
  return {
    algo: FINGERPRINT_ALGO,
    fingerprint: hash.digest("hex"),
    fileCount: files.length,
    bytes,
  };
}

/**
 * The build id `distDir` currently serves, or null. This is the identity of a
 * BUILD — `next build` mints a fresh one every time — which is what lets a record
 * prove it describes the build sitting beside it rather than a previous one.
 */
export function readBuildId(distDir) {
  try {
    return (
      fs.readFileSync(path.join(distDir, "BUILD_ID"), "utf8").trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The recorded fingerprint of the inputs `distDir`'s build was compiled from —
 * or null when there is none, it was written by another algorithm, or it names a
 * build id other than the one now in `distDir`.
 *
 * That last clause is the one doing real work. `next build` is not guaranteed to
 * remove files it did not write, so a record from an earlier build can outlive the
 * build it described; a record that names the wrong build id is exactly the stale
 * proof that would authorize seeding the wrong bundle. Rejecting it costs a cold
 * build, which is the safe direction.
 */
export function readBuildRecord(distDir) {
  let parsed;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(distDir, BUILD_RECORD_BASENAME), "utf8")
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.algo !== FINGERPRINT_ALGO) return null;
  if (typeof parsed.fingerprint !== "string" || !parsed.fingerprint)
    return null;
  const live = readBuildId(distDir);
  if (!live || parsed.buildId !== live) return null;
  return parsed;
}

/**
 * Record the fingerprint of `root`'s build inputs beside the build in `distDir`.
 * Call it AFTER a successful build and never before: the record's whole claim is
 * "these inputs produced that build id".
 *
 * @param {string} root
 * @param {string} distDir
 * @param {Record<string, unknown>} [extra]
 * @param {BuildInputFingerprint | null} [inputs] — see below.
 *
 * `inputs` is a fingerprint the caller ALREADY took, and is how `ensureBuild`
 * records what it verified rather than what it can see now (#5772). Recomputing
 * here would re-read the tree a third time, after the caller established the tree
 * had not moved during the build — and a tree that moves in that last gap would be
 * recorded as the build's provenance without anybody having checked it. Omit it and
 * the fingerprint is taken here, which is right for a caller holding no earlier one.
 */
export function writeBuildRecord(root, distDir, extra = {}, inputs = null) {
  const buildId = readBuildId(distDir);
  if (!buildId)
    throw new Error(`no BUILD_ID in ${distDir} — nothing to record`);
  const { algo, fingerprint, fileCount, bytes } =
    inputs ?? buildInputFingerprint(root);
  const record = {
    algo,
    fingerprint,
    buildId,
    fileCount,
    bytes,
    recordedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(
    path.join(distDir, BUILD_RECORD_BASENAME),
    JSON.stringify(record, null, 2) + "\n"
  );
  return record;
}

/** Enough of a fingerprint to tell two apart in a log line, and no more. */
function shortPrint(fingerprint) {
  return fingerprint ? fingerprint.slice(0, 12) : "none";
}

/**
 * IS THE BUILD IN `distDir` THE ONE THIS TREE WOULD COMPILE? (#5772)
 *
 * Over FACTS and nothing else — no filesystem, no clock — the same shape
 * `seedDecision` in ./build-seed.mjs uses, and deliberately so: seeding already
 * asks "would a build of THIS tree produce the bytes sitting in THAT tree", and
 * staleness is that question asked of the build sitting in this one. One model,
 * asked twice, rather than two models that can disagree.
 *
 * WHY NOT MTIMES, which this replaced. `ensureBuild` compared the newest build
 * input's mtime against `.next/BUILD_ID`'s, and `BUILD_ID` is written at the END
 * of a build that takes minutes — so a source edited after the build STARTED and
 * before `BUILD_ID` landed carries an mtime BELOW it and reads as fresh, for good,
 * until something else touches that file. The hole was never the same-second
 * coincidence #5772 describes; it was as wide as a build. A content fingerprint
 * cannot care how close two operations landed.
 *
 * AND AN UNANSWERABLE COMPARISON IS NOT A FRESH BUILD. Every branch below that
 * cannot establish what the build was compiled from returns `fresh: false`, which
 * costs a rebuild — the direction whose failure is slow rather than wrong.
 *
 * The `reason` is the product, exactly as it is for `seedDecision`: it is printed
 * either way, because a run that silently reuses a build is what let #5772's false
 * green go unnoticed for a whole afternoon.
 *
 * @typedef {{ fresh: boolean, reason: string }} BuildFreshness
 * @returns {BuildFreshness}
 */
export function buildFreshnessDecision(facts) {
  const { hasBuild, recorded, treeFingerprint } = facts;
  if (!hasBuild) {
    return { fresh: false, reason: "there is no production build" };
  }
  if (!treeFingerprint) {
    return {
      fresh: false,
      reason: "this worktree's build inputs could not be read",
    };
  }
  if (!recorded) {
    return {
      fresh: false,
      reason:
        "the build carries no usable record of what it was compiled from " +
        `(no readable ${BUILD_RECORD_BASENAME} naming this build id), so it cannot ` +
        "be shown to match this tree",
    };
  }
  if (recorded.fingerprint !== treeFingerprint) {
    return {
      fresh: false,
      reason:
        "it was compiled from different sources than this worktree has " +
        `(recorded ${shortPrint(recorded.fingerprint)}, tree ${shortPrint(treeFingerprint)})`,
    };
  }
  return {
    fresh: true,
    reason:
      `its recorded inputs are this worktree's (${shortPrint(treeFingerprint)}, ` +
      `${recorded.fileCount} files)`,
  };
}

/**
 * `buildFreshnessDecision` with the facts read off disk.
 *
 * The tree is fingerprinted only when there IS a build to compare it against —
 * hashing ~2 700 files costs ~190 ms, which is nothing beside the build it decides
 * about but is pure waste when the answer is already "build it".
 *
 * @returns {BuildFreshness}
 */
export function readBuildFreshness(root, distDir) {
  const hasBuild = readBuildId(distDir) !== null;
  let treeFingerprint = null;
  if (hasBuild) {
    try {
      treeFingerprint = buildInputFingerprint(root).fingerprint;
    } catch {
      treeFingerprint = null;
    }
  }
  return buildFreshnessDecision({
    hasBuild,
    recorded: hasBuild ? readBuildRecord(distDir) : null,
    treeFingerprint,
  });
}
