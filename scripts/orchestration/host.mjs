// Host resolution for orchestration tooling — one answer per question, however
// many harnesses ask it (#3710).
//
//   node scripts/orchestration/host.mjs state-dir   # print (and create) the state dir
//   node scripts/orchestration/host.mjs node-bin [ref]  # print the .nvmrc-major node bin dir
//       — .nvmrc from the working tree, or from <ref> (a SHA or origin/main) when
//       given, so a checkout behind main cannot answer for main (#4960).
//   node scripts/orchestration/host.mjs node-check  # silent when THIS interpreter
//       is the pinned major; otherwise names both versions, the binary it
//       resolved and the PATH to export, and exits 3 (#5940).
//       CALLED BY run-gates-recorded.sh AND by the seven tier scripts a person
//       types by hand — `dev`, `build`, `lint`, `typecheck`, `test`, `test:db`,
//       `test:e2e` — which prefix it in package.json (#5961). `engine-strict`
//       covers `npm install`/`npm ci` only; npm's run-script path never consults
//       `engines`, so a hand-run tier needed its own refusal. Seven entries, not
//       all ~100: every other script reaches a tier through the gate runner,
//       which already refuses here.
//
// The work bootstrap grew up on one Linux container and hard-coded
// its shape: state in /home/user/scratch, node under /opt/nvm, a token always
// in the environment. A macOS orchestrator has none of those, so dispatch
// failed at worktree setup and the read-only reconciler refused with an
// authenticated `gh` sitting right there. This module is where host variance
// lives; callers stay host-agnostic.
//
// THE LEDGER AND THE ROSTER MUST AGREE on one directory (dispatch-brief.mjs
// carries the incident), so the shell scripts call the CLI form and the JS
// tools import the function — one resolver, not N copies of its order:
//
//   1. $SCRATCH — the explicit override, exactly as before.
//   2. Whichever candidate below ALREADY HOLDS THE LEDGER (allos-dispatch-ledger.jsonl)
//      — before any layout preference. Measured 2026-09-06 (#5385): a session
//      wrote its ledger, roster and four dispatches under ~/.local/state, a lane
//      then created /home/user/scratch, and the next `new` resolved THERE — a
//      fresh ledger, a port base re-allocated over a live lane, `list` reading
//      one lane of five. State stays where it started; a new directory cannot
//      move it.
//   3. /home/user/scratch when it exists — the measured live-container layout.
//   4. $XDG_STATE_HOME/allos-work, else ~/.local/state/allos-work
//      — the durable cross-platform default (macOS included; no per-OS branch).
//   5. os.tmpdir()/allos-work-state — LAST, and explicitly
//      non-durable: only when no home directory is resolvable at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helpGuard } from "./usage.mjs";

/**
 * @typedef {{ exists(p: string): boolean, homedir(): string | null, tmpdir(): string }} HostIo
 */

/** @type {HostIo} */
const defaultIo = {
  exists: (p) => fs.existsSync(p),
  homedir: () => os.homedir(),
  tmpdir: () => os.tmpdir(),
};

/** The dispatch ledger's file name — ledger.mjs joins it onto the resolved dir. */
export const LEDGER_FILE = "allos-dispatch-ledger.jsonl";

/**
 * The one durable state directory the ledger and roster live in.
 * @param {Record<string, string | undefined>} [env]
 * @param {HostIo} [io]
 */
export function resolveStateDir(env = process.env, io = defaultIo) {
  if (env.SCRATCH) return env.SCRATCH;
  const home = env.XDG_STATE_HOME
    ? env.XDG_STATE_HOME
    : io.homedir()
      ? path.join(io.homedir(), ".local", "state")
      : null;
  // The directory was named allos-orchestration until the 2026-09 rename;
  // a machine that already holds state there keeps resolving to it.
  const legacy = home && path.join(home, "allos-orchestration");
  const current = home && path.join(home, "allos-work");
  const holdsLedger = ["/home/user/scratch", current, legacy].find(
    (dir) => dir && io.exists(path.join(dir, LEDGER_FILE))
  );
  if (holdsLedger) return holdsLedger;
  if (io.exists("/home/user/scratch")) return "/home/user/scratch";
  if (home) return !io.exists(current) && io.exists(legacy) ? legacy : current;
  return path.join(io.tmpdir(), "allos-work-state");
}

/**
 * The bin dir of a node matching .nvmrc's major — the RUNNING process first
 * (it is what the caller actually has), then installed version managers, in
 * order: $NVM_DIR, ~/.nvm, /opt/nvm. Never a pinned /opt path, never a pinned
 * patch version — both went stale on real hosts (#3710, and the runbook's own
 * "a pinned patch version went stale within days").
 */
/**
 * @param {string} major
 * @param {Record<string, string | undefined>} [env]
 * @param {HostIo} [io]
 * @param {{ version: string, execPath: string }} [proc]
 */
export function discoverNodeBin(
  major,
  env = process.env,
  io = defaultIo,
  proc = process
) {
  if (proc.version.startsWith(`v${major}.`)) {
    return path.dirname(proc.execPath);
  }
  const managerDirs = [
    env.NVM_DIR ? path.join(env.NVM_DIR, "versions", "node") : null,
    io.homedir() ? path.join(io.homedir(), ".nvm", "versions", "node") : null,
    "/opt/nvm/versions/node",
  ].filter(Boolean);
  for (const dir of managerDirs) {
    if (!io.exists(dir)) continue;
    const best = fs
      .readdirSync(dir)
      .filter((v) => v.startsWith(`v${major}.`))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
    if (best) return path.join(dir, best, "bin");
  }
  return null;
}

/**
 * `.nvmrc`'s node major at a git ref, or — with no ref — in the working tree;
 * null when that read fails. THE ONE READER (#5940). The read and the parsing
 * used to sit inside this file's CLI block, so nothing could import them and
 * dispatch-brief.mjs grew a second copy; "which major is pinned" then had two
 * answers that could drift apart, and the gate guard would have been a third.
 */
/**
 * @param {string} [ref] a SHA or origin/main; omitted reads the working tree
 * @param {(ref?: string) => string | null} [read]
 */
export function nvmrcMajorAt(ref, read = readNvmrc) {
  const major = read(ref)?.trim().replace(/^v/, "").split(".")[0];
  return major || null;
}

/**
 * Both reads answer null rather than throwing, and git's own stderr is
 * dropped: asking for origin/main's `.nvmrc` in a clone that has not fetched
 * it is an ORDINARY miss with a working-tree fallback behind it, not something
 * to print `fatal:` about on every gate run. Callers that need the distinction
 * say so themselves.
 * @param {string} [ref]
 */
function readNvmrc(ref) {
  try {
    return ref
      ? execFileSync("git", ["-C", repoRoot(), "show", `${ref}:.nvmrc`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      : fs.readFileSync(path.join(repoRoot(), ".nvmrc"), "utf8");
  } catch {
    return null;
  }
}

const repoRoot = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Why a gate run must refuse before it starts — or null when this interpreter
 * is the pinned one.
 *
 * REFUSES RATHER THAN WARNS (#5940). Gate results from the wrong major are not
 * noisy, they are unusable IN BOTH DIRECTIONS: a child spawned with
 * `--import tsx` under Node 22 receives a module namespace holding only
 * `default`, so `test:db` failed as `readDataWriteRevision is not a function`
 * in a file the change never touched — identically at commits CI had certified
 * green — while a tier that never exercised its real behaviour reports PASS.
 * A warning at the top of a 2,500-line log is not read.
 *
 * It names BOTH majors, the binary actually resolved and the bin dir to
 * export, because the fix is a PATH the operator has to construct and the
 * default `node` is the one thing the message cannot assume.
 */
/**
 * @param {{ pinned: string | null, at: string, version: string,
 *           execPath: string, bin: string | null }} found
 */
export function nodePinRefusal({ pinned, at, version, execPath, bin }) {
  if (!pinned) {
    return `.nvmrc could not be read ${at}, so ${version} at ${execPath} cannot be checked against the pin`;
  }
  if (version.replace(/^v/, "").split(".")[0] === pinned) return null;
  return (
    `this shell runs node ${version} (${execPath}) but .nvmrc ${at} pins ${pinned}. ` +
    (bin
      ? `Run \`export PATH=${bin}:$PATH\` in EVERY shell, then re-run.`
      : `No node ${pinned} is installed here, so no PATH fixes it — install it.`)
  );
}

/**
 * Read-only token fallback: the env variables by name, else `gh auth token`
 * from an authenticated gh. The helper is the sanctioned credential source on
 * hosts that authenticate through gh instead of exporting a variable — it is
 * NOT a filesystem search, which recovery.md §Lost credentials still
 * forbids. Read paths only: the write tools keep requiring the variables.
 */
/**
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof execFileSync} [exec]
 */
export function resolveReadToken(env = process.env, exec = execFileSync) {
  const fromEnv = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
  if (fromEnv) return fromEnv;
  try {
    const out = exec("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// CLI: used by the shell scripts (orchestrator-checkin.sh, pm-digest.sh)
// so their STATE_DIR is this resolver's answer, not a re-implementation.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  helpGuard(process.argv, import.meta.url);
  const command = process.argv[2];
  if (command === "state-dir") {
    const dir = resolveStateDir();
    fs.mkdirSync(dir, { recursive: true });
    console.log(dir);
  } else if (command === "node-bin") {
    const ref = process.argv[3];
    const major = nvmrcMajorAt(ref);
    if (!major) {
      // Exit 2, apart from 1 (no node): the caller must not print "no node
      // installed" over a .nvmrc it never read.
      console.error(
        `host.mjs: could not read .nvmrc at ${ref ?? "the working tree"}`
      );
      process.exit(2);
    }
    const bin = discoverNodeBin(major);
    if (!bin) {
      console.error(`host.mjs: no node ${major} found (.nvmrc)`);
      process.exit(1);
    }
    console.log(bin);
  } else if (command === "node-check") {
    // origin/main first, the working tree as the named fallback: a lane
    // branches from origin/main, so that tree's pin is the one its gates are
    // judged against. dispatch-brief.mjs's `nodePin` states the same order for
    // the brief it writes; this enforces it for the run.
    const atMain = nvmrcMajorAt("refs/remotes/origin/main");
    const pinned = atMain ?? nvmrcMajorAt();
    let at = "at origin/main or in this working tree";
    if (atMain) at = "at origin/main";
    else if (pinned) at = "in this working tree (origin/main's was unreadable)";
    const refusal = nodePinRefusal({
      pinned,
      at,
      version: process.version,
      execPath: process.execPath,
      bin: pinned ? discoverNodeBin(pinned) : null,
    });
    if (refusal) {
      console.error(`host.mjs: ${refusal}`);
      process.exit(3);
    }
  } else {
    console.error(
      `host.mjs: unknown command ${command ?? "(none)"} — see --help`
    );
    process.exit(2);
  }
}
