// Hand a fresh agent worktree a production build instead of making it compile one
// (#2605). Measured on the 4-core orchestration box: 199 s to build, 1.7 s to seed.
//
// ---------------------------------------------------------------------------
// WHEN it runs, and why that is the whole design
//
// The issue proposed copying `.next` at worktree-creation time, from the main
// checkout, guarded on commit equality. Both halves turned out wrong on the real
// box, and both failures are visible in one measurement:
//
//   - THE SOURCE. The main checkout sits on the orchestrator's own dispatch
//     branch, whose `.next` was eleven hours stale against its own tree and whose
//     `lib/` genuinely differs from `origin/main`. Seeding from it would have
//     refused every time. The trees that DO match are the sibling agent
//     worktrees — five of them, all branched from the same `origin/main`. So the
//     source is discovered, not fixed.
//   - THE MOMENT. At worktree creation no sibling has built yet either. The first
//     cluster of a wave must build; the rest can only benefit if they ask LATER.
//     So this runs from `ensureBuild`, at the moment a build is found missing,
//     which also means no brief step to forget and no window in which a seeded
//     build can be mistaken for one the agent made.
//
// ---------------------------------------------------------------------------
// WHAT licenses a seed
//
// Not the commit. Commit equality is neither necessary (the orchestrator branch
// differs only in `scripts/` and `docs/`, which the build does not read) nor
// sufficient (same HEAD plus one uncommitted edit under `lib/` is a different
// bundle). The precondition is a content fingerprint over exactly the files
// `ensureBuild` treats as build inputs — one declaration, in ./build-inputs.mjs,
// shared with the staleness check rather than copied.
//
// The dependency tree is the assumption NOT hashed: every worktree's
// `node_modules` is `cp -al`'d from the same canonical tree, so it is bit-identical
// by construction, and `package-lock.json` is itself a build input.
//
// ---------------------------------------------------------------------------
// HAZARDS
//
//   HARDLINKS. `node_modules` is seeded with `cp -al`; doing that to `.next` would
//   be a trap, because a hard link shares an INODE and this worktree's own later
//   `next build` — or merely the BUILD_ID mtime stamp below — would write through
//   into the source tree. The copy is `cp -a --reflink=auto` (copy-on-write where
//   the filesystem offers it, a real copy otherwise; never a link) and `nlink === 1`
//   is ASSERTED afterwards, so a future "optimization" to `-l` fails loudly.
//
//   STALENESS. A seeded worktree the agent then edits falls straight back to
//   `ensureBuild`'s ordinary mtime rule and rebuilds — BUILD_ID is stamped to now,
//   so every later edit is newer. That path is untouched.
//
//   CONCURRENCY. Five clusters can seed at once. Sources are only ever READ, so
//   concurrent seeds need no lock. The one non-read-only race is a rebuild landing
//   in a source mid-copy, which would yield a torn mixture of two builds: the
//   source's build id and record are re-read afterwards and must be unchanged, and
//   the copy stages in a temp dir renamed into place, so a torn or interrupted seed
//   leaves no `.next` at all rather than half of one.
//
//   CI. Untouched, and unreachable: `ensureBuild` returns under `CI` before this
//   runs, CI has no sibling worktrees, and its own Next cache restore is unchanged.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  buildInputFingerprint,
  newestBuildInputMtime,
  readBuildId,
  readBuildRecord,
  writeBuildRecord,
} from "./build-inputs.mjs";

/** Deriving a proof means fingerprinting the source too — bound how often. */
const MAX_DERIVED_CANDIDATES = 3;

/**
 * `.next/cache` is NOT seeded, and that is a measurement rather than caution.
 *
 * It is 515 MB of a 753 MB build directory — two thirds of the copy and two thirds
 * of the disk every worktree then holds. Its only possible payoff is a faster
 * REBUILD after the agent edits something, and it does not deliver one: a worktree
 * seeded with the cache, then given a one-line edit under `lib/`, rebuilt in 289 s
 * against 199 s cold. The compiler's cache entries are keyed on absolute paths from
 * the worktree that wrote them, so in a differently-named directory they are asked
 * for by nobody — they cannot be wrongly HIT (no other tree's path resolves here),
 * they are simply dead weight.
 *
 * So the seed carries the ~239 MB the server actually serves. `next start`
 * recreates the runtime cache directory it needs.
 */
const SEED_EXCLUDED_ENTRIES = new Set(["cache"]);

/**
 * The whole decision, over facts and nothing else — no filesystem, no clock.
 *
 * The refusal REASONS are the product here. This feature's measure of working is
 * its refusal count with causes, never rounds-per-hour: a seeding bug makes rounds
 * faster AND wrong, so speed is exactly the metric that cannot detect it.
 */
export function seedDecision(facts) {
  const {
    sourceBuildId,
    targetHasBuild,
    recorded,
    sourceFingerprint,
    sourceNewestInputMs,
    sourceNewestInputPath,
    sourceBuiltAtMs,
    targetFingerprint,
  } = facts;

  if (!sourceBuildId) {
    return { seed: false, reason: "it has no production build" };
  }
  if (targetHasBuild) {
    return {
      seed: false,
      reason:
        "this worktree already has a production build — refusing to overwrite it",
    };
  }
  if (!targetFingerprint) {
    return { seed: false, reason: "this worktree's build inputs could not be read" };
  }

  if (recorded) {
    if (recorded.fingerprint !== targetFingerprint) {
      return {
        seed: false,
        reason: "its build was compiled from different sources than this worktree has",
      };
    }
    return { seed: true, proof: "recorded" };
  }

  // No record beside the build — it predates this tooling, or came from
  // `npm run build`. The same fact can be DERIVED, at the cost of one extra
  // assumption the recorded proof does not need: that the source tree has not
  // changed since it was built. Say which proof was used.
  if (!sourceFingerprint) {
    return { seed: false, reason: "its build inputs could not be read" };
  }
  if (!(sourceBuiltAtMs > 0)) {
    return { seed: false, reason: "its BUILD_ID has no readable mtime" };
  }
  if (sourceNewestInputMs > sourceBuiltAtMs) {
    return {
      seed: false,
      reason:
        `its build is stale against its own tree (${sourceNewestInputPath ?? "a build input"} ` +
        "is newer than BUILD_ID), so what it was built from cannot be established",
    };
  }
  if (sourceFingerprint !== targetFingerprint) {
    return { seed: false, reason: "its build inputs differ from this worktree's" };
  }
  return { seed: true, proof: "derived" };
}

// --- filesystem side -------------------------------------------------------

function copyOne(src, dest) {
  // --reflink=auto: copy-on-write when the filesystem supports it, a full copy
  // otherwise. NEVER -l. See the hardlink hazard note at the top.
  let res = spawnSync("cp", ["-a", "--reflink=auto", src, dest], {
    encoding: "utf8",
  });
  if (res.status !== 0 && /reflink/i.test(res.stderr || "")) {
    res = spawnSync("cp", ["-a", src, dest], { encoding: "utf8" });
  }
  if (res.status !== 0) {
    throw new Error(`cp failed: ${(res.stderr || "").trim() || res.status}`);
  }
}

/** Copy a build directory entry by entry, minus what is not worth carrying. */
function copyBuild(srcDist, destDist) {
  fs.mkdirSync(destDist, { recursive: true });
  for (const entry of fs.readdirSync(srcDist)) {
    if (SEED_EXCLUDED_ENTRIES.has(entry)) continue;
    copyOne(path.join(srcDist, entry), path.join(destDist, entry));
  }
}

function sourceIdentity(dist) {
  const record = readBuildRecord(dist);
  return {
    buildId: readBuildId(dist),
    recordedFingerprint: record ? record.fingerprint : null,
  };
}

function buildIdMtimeMs(dist) {
  try {
    return fs.statSync(path.join(dist, "BUILD_ID")).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Every checkout that could hold a compatible build: the main checkout and every
 * linked worktree, most recently built first (the freshest build is the likeliest
 * to have been made from the `origin/main` a new worktree just branched from).
 * Checkouts with no build at all are dropped here rather than refused later.
 */
export function discoverSeedSources(to, distName = ".next") {
  const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: to,
    encoding: "utf8",
  });
  if (res.status !== 0) return [];
  const target = path.resolve(to);
  const dirs = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const dir = path.resolve(line.slice("worktree ".length).trim());
    if (dir !== target) dirs.push(dir);
  }
  return dirs
    .map((dir) => ({ dir, builtAtMs: buildIdMtimeMs(path.join(dir, distName)) }))
    .filter((c) => c.builtAtMs > 0)
    .sort((a, b) => b.builtAtMs - a.builtAtMs)
    .map((c) => c.dir);
}

/** Try one source. Copies on success; leaves the target untouched otherwise. */
export function seedFrom({ from, to, distName = ".next", targetFingerprint, derive }) {
  const sourceDist = path.join(from, distName);
  const targetDist = path.join(to, distName);
  const recorded = readBuildRecord(sourceDist);

  const facts = {
    sourceBuildId: readBuildId(sourceDist),
    targetHasBuild: fs.existsSync(path.join(targetDist, "BUILD_ID")),
    recorded,
    targetFingerprint,
    sourceFingerprint: null,
    sourceNewestInputMs: 0,
    sourceNewestInputPath: null,
    sourceBuiltAtMs: 0,
  };
  if (!recorded && facts.sourceBuildId && !facts.targetHasBuild) {
    if (!derive) {
      return { seed: false, reason: "it has no recorded build inputs" };
    }
    facts.sourceFingerprint = buildInputFingerprint(from).fingerprint;
    const newest = newestBuildInputMtime(from);
    facts.sourceNewestInputMs = newest.ms;
    facts.sourceNewestInputPath = newest.path;
    facts.sourceBuiltAtMs = buildIdMtimeMs(sourceDist);
  }

  const verdict = seedDecision(facts);
  if (!verdict.seed) return verdict;

  const before = sourceIdentity(sourceDist);
  const tmp = path.join(to, `.next.seeding-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  const started = Date.now();
  try {
    copyBuild(sourceDist, tmp);

    // The copy must own its bytes.
    const copiedBuildId = path.join(tmp, "BUILD_ID");
    const nlink = fs.statSync(copiedBuildId).nlink;
    if (nlink !== 1) {
      throw new Error(
        `the copy shares inodes with ${sourceDist} (BUILD_ID has ${nlink} links), ` +
          "which would let this worktree's build corrupt another's"
      );
    }

    // A rebuild in the source mid-copy would have handed over a torn mixture.
    const after = sourceIdentity(sourceDist);
    if (
      after.buildId !== before.buildId ||
      after.recordedFingerprint !== before.recordedFingerprint
    ) {
      throw new Error("its build changed while it was being copied (a rebuild landed mid-seed)");
    }

    // `cp -a` preserved the source's mtimes, which read as older than this
    // worktree's just-created sources and would make `ensureBuild` rebuild the very
    // build it was handed. Stamp BUILD_ID forward — licensed by the fingerprint
    // equality proven above and by nothing else. Every later edit is newer again,
    // so ordinary staleness detection resumes untouched.
    const now = new Date();
    fs.utimesSync(copiedBuildId, now, now);

    fs.renameSync(tmp, targetDist);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { seed: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // The seeded tree carries the same proof, so it is auditable and can itself be
  // seeded from — which is what lets one build spread across a whole wave.
  writeBuildRecord(to, targetDist, {
    seededFrom: from,
    seededAt: new Date().toISOString(),
    proof: verdict.proof,
  });
  return { ...verdict, from, ms: Date.now() - started };
}

/**
 * Seed `to` from the first compatible checkout found. Recorded proofs are tried
 * first across every candidate (a cheap file read), then derived ones (which cost
 * a fingerprint of the source as well) over the few most recently built.
 *
 * Returns `{ seed: false, attempts }` when nothing matched. Every attempt carries
 * its reason: a silent refusal would be indistinguishable from no candidates, and
 * refusals are the signal this feature is judged by.
 */
export function seedNextBuild({ to, from = null, distName = ".next" }) {
  const targetDist = path.join(to, distName);
  if (fs.existsSync(path.join(targetDist, "BUILD_ID"))) {
    return {
      seed: false,
      attempts: [
        {
          from: to,
          reason: "this worktree already has a production build — refusing to overwrite it",
        },
      ],
    };
  }

  const candidates = from ? [path.resolve(from)] : discoverSeedSources(to, distName);
  if (!candidates.length) return { seed: false, attempts: [] };

  const targetFingerprint = buildInputFingerprint(to).fingerprint;
  const attempts = [];
  // A candidate whose RECORD answered is settled: the record is the authoritative
  // proof, so re-asking it by deriving would spend a fingerprint to reach the same
  // verdict, and would report the same refusal twice.
  const settled = new Set();
  for (const derive of [false, true]) {
    let derived = 0;
    for (const candidate of candidates) {
      if (settled.has(candidate)) continue;
      if (derive && derived >= MAX_DERIVED_CANDIDATES) break;
      if (derive) derived++;
      const result = seedFrom({
        from: candidate,
        to,
        distName,
        targetFingerprint,
        derive,
      });
      if (result.seed) return { ...result, attempts };
      // The cheap pass reports "no recorded build inputs" for every candidate the
      // expensive pass will look at properly — noise, not a reason.
      if (derive || result.reason !== "it has no recorded build inputs") {
        settled.add(candidate);
        attempts.push({ from: candidate, reason: result.reason });
      }
    }
  }
  return { seed: false, attempts };
}
