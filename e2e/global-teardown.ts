import fs from "node:fs";
import path from "node:path";
import { E2E_DATA_DIR } from "./worker-env";

/** The file naming the RUNNER process that currently owns a run root (#3921). */
export const RUN_LOCK_BASENAME = "run.lock";

// Sweep any per-worker server that outlived its worker (issue #1538).
//
// The worker fixture stops its own server on teardown, but a worker that is
// hard-killed — an interrupted run, a Playwright shutdown that doesn't wait for
// fixture teardown — never gets there, and an orphaned `next start` would hold its
// port against the NEXT run. The worker holding a slot records its pid in
// <run root>/slot-<n>.pid, so cleaning up is just walking those files. (Belt and
// braces: the fixture also reclaims its slot's port at startup, so a survivor of a
// `kill -9`'d run is handled there too.)
//
// The root is a PARAMETER because run roots are now per port range (#3921): this
// run sweeps its own by default, and global-setup sweeps a stale sibling's before
// reclaiming it — an orphan on another range still holds a real listener, so
// per-range roots must not narrow what this finds.
export function stopLeftoverWorkerServers(root: string = E2E_DATA_DIR): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^slot-\d+\.pid$/.test(entry.name)) continue;
    const pidFile = path.join(root, entry.name);
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    fs.rmSync(pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGTERM");
      console.log(
        `[e2e] stopped leftover server for ${entry.name.replace(".pid", "")} (pid ${pid})`
      );
    } catch {
      // already gone
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  stopLeftoverWorkerServers();
  // Release this run's claim on its root. The claim is really the runner pid being
  // ALIVE (see e2e/global-setup.ts), so a hard-killed run needs no cleanup here —
  // dropping the file just keeps a recycled pid from ever reading as a live run.
  fs.rmSync(path.join(E2E_DATA_DIR, RUN_LOCK_BASENAME), { force: true });
}
