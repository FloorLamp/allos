// Host resolution for orchestration tooling — one answer per question, however
// many harnesses ask it (#3710).
//
//   node scripts/orchestration/host.mjs state-dir   # print (and create) the state dir
//   node scripts/orchestration/host.mjs node-bin    # print the .nvmrc-major node bin dir
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
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      ".."
    );
    const major = fs
      .readFileSync(path.join(repoRoot, ".nvmrc"), "utf8")
      .trim()
      .replace(/^v/, "")
      .split(".")[0];
    const bin = discoverNodeBin(major);
    if (!bin) {
      console.error(`host.mjs: no node ${major} found (.nvmrc)`);
      process.exit(1);
    }
    console.log(bin);
  } else {
    console.error(
      `host.mjs: unknown command ${command ?? "(none)"} — see --help`
    );
    process.exit(2);
  }
}
