import fs from "node:fs";
import path from "node:path";
import { E2E_DATA_DIR } from "./worker-env";

// Sweep any per-worker server that outlived its worker (issue #1538).
//
// The worker fixture stops its own server on teardown, but a worker that is
// hard-killed — an interrupted run, a Playwright shutdown that doesn't wait for
// fixture teardown — never gets there, and an orphaned `next start` would hold its
// port against the NEXT run. The worker holding a slot records its pid in
// e2e/.data/slot-<n>.pid, so cleaning up is just walking those files. (Belt and
// braces: the fixture also reclaims its slot's port at startup, so a survivor of a
// `kill -9`'d run is handled there too.)
export function stopLeftoverWorkerServers(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(E2E_DATA_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^slot-\d+\.pid$/.test(entry.name)) continue;
    const pidFile = path.join(E2E_DATA_DIR, entry.name);
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
}
