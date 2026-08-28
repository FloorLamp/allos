// TWO PLAYWRIGHT RUNS IN ONE CHECKOUT MUST NOT OBSERVE EACH OTHER'S FIXTURES
// (#3921).
//
// The worker directory used to be keyed on the worker index alone, so a second
// run in the same checkout claimed `e2e/.data/worker-0/` and `rmSync`'d the
// first's seeded database and auth state mid-run. The reds that produced were not
// the cost — the GREENS were: a spec that finished before its data was swapped
// reports a pass that means nothing, and nothing distinguishes it from a real one.
// So the property is asserted here rather than observed once.
//
// WHAT THIS DRIVES IS THE REAL SETUP PATH, not a model of it: `claimRunRoot` and
// `reclaimStaleRunRoots` are the functions `e2e/global-setup.ts` calls, and
// `dataRootFor` is what every process in the run derives its paths from. What it
// does NOT boot is Playwright itself — the claim under test is a filesystem
// lifecycle, so the seeded database stands in as an ordinary file. A real
// two-run check needs two `next build`s and belongs to the harness, not to a
// tier that must stay pure.
//
// EVERY CASE HAS ITS CONVERSE. An isolation assertion is satisfied by a world
// where nothing happened at all, so each "survives" below is paired with the
// call that must destroy it.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claimRunRoot, reclaimStaleRunRoots } from "../../e2e/global-setup";
import { RUN_LOCK_BASENAME } from "../../e2e/global-teardown";
import { dataRootFor } from "../../e2e/worker-env";
import { makeTmpDir } from "./tmp-dir";

const alive: ChildProcess[] = [];

afterEach(() => {
  while (alive.length) alive.pop()?.kill("SIGKILL");
});

/** A pid that is running right now, and is not this process. */
function livePid(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  alive.push(child);
  if (!child.pid) throw new Error("could not spawn a live process");
  return child.pid;
}

/** A pid that has already exited (pids climb, so this one is not reused). */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("could not spawn a dead process");
  return pid;
}

function seedRoot(root: string, lock?: number): string {
  const db = path.join(root, "worker-0", "app.db");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, "seeded");
  if (lock !== undefined) {
    fs.writeFileSync(path.join(root, RUN_LOCK_BASENAME), String(lock));
  }
  return db;
}

describe("the e2e run root is per port range (#3921)", () => {
  // The derivation, which is the half that cannot be forgotten: a run's paths
  // follow from E2E_PORT, which every process in the chain already reads.
  it.each([
    [3100, 6500],
    [5900, 7000], // the ports of the collision that filed the issue
  ])("keeps runs on %i and %i in disjoint roots", (a, b) => {
    const repo = makeTmpDir("e2e-run-root");
    const rootA = dataRootFor(repo, a);
    const rootB = dataRootFor(repo, b);
    expect(rootA).not.toEqual(rootB);
    expect(rootA.startsWith(rootB + path.sep)).toBe(false);
    expect(rootB.startsWith(rootA + path.sep)).toBe(false);
    expect(path.dirname(rootA)).toEqual(path.join(repo, "e2e", ".data"));
  });

  it("a second run's setup leaves the first run's seeded database alone", () => {
    const repo = makeTmpDir("e2e-run-root");
    const rootA = dataRootFor(repo, 5900);
    const rootB = dataRootFor(repo, 7000);
    const dbA = seedRoot(rootA, livePid());

    claimRunRoot(rootB);
    expect(fs.existsSync(dbA)).toBe(true);

    // The converse: the same call against A's OWN root does destroy it, so the
    // assertion above is about isolation and not about a reset that never runs.
    fs.rmSync(path.join(rootA, RUN_LOCK_BASENAME));
    claimRunRoot(rootA);
    expect(fs.existsSync(dbA)).toBe(false);
  });

  it("refuses a live sibling on the same range, and reclaims a dead one's", () => {
    const repo = makeTmpDir("e2e-run-root");
    const root = dataRootFor(repo, 3100);
    seedRoot(root, livePid());
    expect(() => claimRunRoot(root)).toThrow(/already owns/);

    fs.writeFileSync(path.join(root, RUN_LOCK_BASENAME), String(deadPid()));
    expect(() => claimRunRoot(root)).not.toThrow();
    expect(fs.readFileSync(path.join(root, RUN_LOCK_BASENAME), "utf8")).toEqual(
      String(process.pid)
    );
  });

  it("reclaims finished roots, keeps claimed ones, and stops their servers", async () => {
    const repo = makeTmpDir("e2e-run-root");
    const parent = path.join(repo, "e2e", ".data");
    const mine = dataRootFor(repo, 6500);
    const finished = dataRootFor(repo, 3100);
    const busy = dataRootFor(repo, 7000);
    seedRoot(mine, process.pid);
    seedRoot(finished, deadPid());
    seedRoot(busy, livePid());
    // A server that outlived the finished run still holds a real listener, so the
    // sweep global-teardown does for its own root must still reach this one.
    const orphan = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        stdio: "ignore",
      }
    );
    alive.push(orphan);
    const orphanExit = new Promise<void>((r) => orphan.once("exit", () => r()));
    fs.writeFileSync(path.join(finished, "slot-0.pid"), String(orphan.pid));

    expect(reclaimStaleRunRoots(parent, mine)).toEqual([finished]);
    expect(fs.existsSync(finished)).toBe(false);
    expect(fs.existsSync(path.join(mine, "worker-0", "app.db"))).toBe(true);
    expect(fs.existsSync(path.join(busy, "worker-0", "app.db"))).toBe(true);
    await orphanExit;
  });
  // The flat layout every checkout that predates the move still holds. It is
  // reclaimed once — and the same case pins the sweep's SILENCE on the neighbours
  // that merely look like it, because this directory also holds live run roots and
  // a predicate that over-reached would delete the fixtures of a running suite.
  it("reclaims the pre-move flat layout and leaves its near-misses alone", () => {
    const repo = makeTmpDir("e2e-run-root");
    const parent = path.join(repo, "e2e", ".data");
    const mine = dataRootFor(repo, 6500);
    seedRoot(mine, process.pid);
    const legacy = ["template", "template-demo", "worker-0", "worker-11"];
    const benign = ["templates", "worker-notes", "portable", "port-notes"];
    for (const name of [...legacy, ...benign]) {
      fs.mkdirSync(path.join(parent, name), { recursive: true });
    }
    fs.writeFileSync(path.join(parent, "run-context.json"), "{}");
    fs.writeFileSync(path.join(parent, "slot-0.pid"), String(deadPid()));

    const reclaimed = reclaimStaleRunRoots(parent, mine).map((p) =>
      path.basename(p)
    );
    expect(reclaimed.sort()).toEqual(
      [...legacy, "run-context.json", "slot-0.pid"].sort()
    );
    for (const name of benign) {
      expect(fs.existsSync(path.join(parent, name))).toBe(true);
    }
    expect(fs.existsSync(path.join(mine, "worker-0", "app.db"))).toBe(true);
  });
});
