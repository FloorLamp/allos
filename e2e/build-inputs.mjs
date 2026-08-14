// What the production build READS, and the fingerprint over it (#2605).
//
// `ensureBuild` (e2e/global-setup.ts) has always owned this declaration, to answer
// "is `.next` older than any source the build compiled". The seeding step in
// scripts/orchestration/seed-next-build.mjs asks a DIFFERENT question of the same
// declaration — "would a build of THIS tree produce the bytes already sitting in
// THAT tree" — so the declaration moved here rather than being copied. Two copies
// of an invalidation rule is the one shape that fails silently: the copy that is
// wrong does not throw, it serves a stale bundle.
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
 * DIRECTORIES COUNT HERE, unlike in `ensureBuild`'s own walk. Deleting a source
 * file changes no surviving file's mtime, only its parent directory's — so a
 * file-only walk cannot see a deletion, and would call a build fresh that no
 * longer matches the tree. `ensureBuild` can live with that (it errs toward not
 * rebuilding a build the agent just made); a SEED cannot, because the same
 * blindness would ship one worktree's bundle into another.
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
      if (NON_BUILD_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
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
    return fs.readFileSync(path.join(distDir, "BUILD_ID"), "utf8").trim() || null;
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
  if (typeof parsed.fingerprint !== "string" || !parsed.fingerprint) return null;
  const live = readBuildId(distDir);
  if (!live || parsed.buildId !== live) return null;
  return parsed;
}

/**
 * Record the fingerprint of `root`'s build inputs beside the build in `distDir`.
 * Call it AFTER a successful build and never before: the record's whole claim is
 * "these inputs produced that build id".
 */
export function writeBuildRecord(root, distDir, extra = {}) {
  const buildId = readBuildId(distDir);
  if (!buildId) throw new Error(`no BUILD_ID in ${distDir} — nothing to record`);
  const { algo, fingerprint, fileCount, bytes } = buildInputFingerprint(root);
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
