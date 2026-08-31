import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allocateUxServedDb,
  assertUxServedDbOwned,
  assertUxServedDbUnused,
  cleanupUxServedDb,
} from "../../scripts/ux-served-db.mjs";
import { makeTmpDir } from "../__tests__/tmp-dir";
import { perTestCeiling } from "../../vitest.timeouts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

function runSeed(dbPath: string, shape: "baseline" | "dirty") {
  const env = {
    ...process.env,
    ALLOS_DB_PATH: dbPath,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "first-boot-pw-1",
    SEED_DIAL_SHAPE: shape === "dirty" ? "dirty" : "",
    SEED_RNG: shape === "baseline" ? "1" : "",
    SEED_PERSONA: "",
    UX_SEED: "",
  };
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repo, "scripts", "seed.ts")],
    { cwd: repo, env, encoding: "utf8" }
  );
}

function runWitness(dbPath: string, uxSeed = "dirty") {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repo, "scripts", "verify-ux-seed-shape.ts")],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOS_DB_PATH: dbPath,
        UX_OWNED_DB_DIR: path.dirname(dbPath),
        UX_SEED: uxSeed,
      },
    }
  );
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No TCP port allocated"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

type ServerReceipt = {
  event: string;
  dbPath?: string;
  descendantPid?: number;
};

function readServerReceipts(receipt: string): ServerReceipt[] {
  if (!fs.existsSync(receipt)) return [];
  return fs
    .readFileSync(receipt, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ServerReceipt);
}

function writeFakeNpm(fakeBin: string): void {
  fs.mkdirSync(fakeBin);
  const listener = path.join(fakeBin, "fake-dev-listener.cjs");
  fs.writeFileSync(
    listener,
    `const fs = require("node:fs");
const http = require("node:http");
const append = (value) => fs.appendFileSync(process.env.FAKE_SERVER_RECEIPT, JSON.stringify(value) + "\\n");
fs.writeFileSync(process.env.ALLOS_DB_PATH + "-wal", "owned wal");
fs.writeFileSync(process.env.ALLOS_DB_PATH + "-shm", "owned shm");
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") res.setHeader("x-allos-ux-census-nonce", process.env.UX_CENSUS_SERVER_NONCE);
  res.statusCode = 200;
  res.end("ok");
});
server.on("error", (error) => { append({ event: "listener-error", code: error.code }); process.exit(91); });
server.listen(Number(process.env.PORT), "127.0.0.1", () => append({ event: "start", dbPath: process.env.ALLOS_DB_PATH, descendantPid: process.pid }));
process.on("SIGTERM", () => server.close(() => { append({ event: "stop", descendantPid: process.pid }); process.exit(0); }));
`
  );
  const fakeNpm = path.join(fakeBin, "npm");
  fs.writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const append = (value) => fs.appendFileSync(process.env.FAKE_SERVER_RECEIPT, JSON.stringify(value) + "\\n");
const child = spawn(process.execPath, [${JSON.stringify(listener)}], { env: process.env, stdio: "ignore" });
append({ event: "wrapper-start", descendantPid: child.pid });
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 92 : 0)));
process.on("SIGTERM", () => { append({ event: "wrapper-stop", descendantPid: child.pid }); process.exit(0); });
setInterval(() => {}, 1000);
`
  );
  fs.chmodSync(fakeNpm, 0o755);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(predicate(), message).toBe(true);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ONE CEILING FOR THE FILE, AND IT IS A MULTIPLE (#3986). Every test here blocks
// in `spawnSync` on real `node --import tsx` children — the seed script, the
// witness, the whole ux-walkthrough harness — so its wall time is a reading of how
// much CPU the box had left, and this file was the dispatch box's most frequent
// local red. The hard-coded `}, 30_000)` / `}, 40_000)` they carried was the one
// thing `ALLOS_VITEST_TIMEOUT_MS` could not reach, so the lever the harness offers
// for exactly this situation stopped at the file that needed it most. As a
// multiple it scales with whichever half of the design is in force: 45 000 ms on
// CI, four times that under `agent-gates.sh`.
//
// THE READING IS THE FILE'S, not each test's — the default reporter prints per
// file, so the shared ceiling covers every remaining child-process case rather
// than pretending the runner supplied a stable per-test CI budget. Named rather
// than inline only so the `describe` line still fits. The basis is the observed
// worst reading rather than a green one (#4002).
const SEED_CEILING = { timeout: perTestCeiling(3, "worst") };

describe("dirty seed and served DB lifecycles", SEED_CEILING, () => {
  it("distinguishes dirty from baseline and keeps the baseline outside served allocations", () => {
    const dirtyPath = path.join(makeTmpDir("dirty-witness-ok"), "allos.db");
    const dirty = runSeed(dirtyPath, "dirty");
    expect(dirty.status, dirty.stderr || dirty.stdout).toBe(0);
    const verified = runWitness(dirtyPath);
    expect(verified.status, verified.stderr || verified.stdout).toBe(0);
    expect(verified.stdout).toContain("verified dirty UX database");

    const baselinePath = path.join(
      makeTmpDir("dirty-witness-missing"),
      "allos.db"
    );
    const baseline = runSeed(baselinePath, "baseline");
    expect(baseline.status, baseline.stderr || baseline.stdout).toBe(0);
    const mislabeled = runWitness(baselinePath);
    expect(mislabeled.status).not.toBe(0);
    expect(mislabeled.stderr).toContain("Dirty seed witnesses do not match");

    const before = fs.readFileSync(baselinePath);
    const directDirty = runSeed(baselinePath, "dirty");
    expect(directDirty.status).not.toBe(0);
    expect(directDirty.stderr).toContain(
      "Database already has data — refusing named seed shape dirty"
    );

    const dir = path.dirname(baselinePath);
    const allocations = [
      allocateUxServedDb(dir),
      allocateUxServedDb(dir),
      allocateUxServedDb(dir),
      allocateUxServedDb(dir),
    ];
    try {
      expect(new Set(allocations.map(({ dbPath }) => dbPath)).size).toBe(4);
      for (const allocation of allocations) {
        expect(allocation.dbPath).not.toBe(baselinePath);
        assertUxServedDbOwned(allocation);
        assertUxServedDbUnused(allocation);
      }
      expect(fs.readFileSync(baselinePath)).toEqual(before);
    } finally {
      for (const allocation of allocations) cleanupUxServedDb(allocation);
    }
  });

  it("aborts when the real thin post-seed child fails", () => {
    const dir = makeTmpDir("seed-shape-thin-child-failure");
    const callerDb = path.join(dir, "caller.db");
    fs.writeFileSync(callerDb, "stale caller bytes");
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "scripts", "ux-walkthrough.mjs"), "--serve", "pages"],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          ALLOS_DB_PATH: callerDb,
          UX_SHOTS: path.join(dir, "shots"),
          UX_SEED: "thin",
          UX_THIN_DAYS: "not-a-number",
          SEED_RNG: "",
          SEED_PERSONA: "",
          SEED_DIAL_SHAPE: "",
        },
      }
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("thinning scratch DB to the last ~7 days");
    expect(result.stderr).toContain(
      "post-seed transform exited non-zero for thin — aborting instead of censusing the full seed under the thin label"
    );
    expect(result.stdout).not.toContain("starting dev server");
    expect(fs.readFileSync(callerDb, "utf8")).toBe("stale caller bytes");
    const claimed = result.stdout.match(
      /claimed private scratch DB path: (.+\/allos\.db)/
    )?.[1];
    expect(claimed).toBeTruthy();
    expect(fs.existsSync(path.dirname(claimed!))).toBe(false);
    expect(result.stdout).toContain("scratch DB and sidecars removed");
  });

  it("stops the served child and removes its DB after a later browser failure", async () => {
    const dir = makeTmpDir("seed-shape-browser-failure");
    const fakeBin = path.join(dir, "bin");
    const receipt = path.join(dir, "server-receipt.jsonl");
    writeFakeNpm(fakeBin);
    const port = await availablePort();
    const result = spawnSync(
      process.execPath,
      [path.join(repo, "scripts", "ux-walkthrough.mjs"), "--serve", "pages"],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          FAKE_SERVER_RECEIPT: receipt,
          ALLOS_DB_PATH: ":memory:",
          UX_BASE: `http://127.0.0.1:${port}`,
          UX_CHROMIUM: path.join(dir, "missing-chromium"),
          UX_SHOTS: path.join(dir, "shots"),
          UX_SEED: "",
          SEED_RNG: "",
          SEED_PERSONA: "",
          SEED_DIAL_SHAPE: "",
        },
      }
    );

    expect(result.status).not.toBe(0);
    const events = readServerReceipts(receipt);
    expect(events.map(({ event }) => event)).toEqual(
      expect.arrayContaining(["wrapper-start", "start", "wrapper-stop", "stop"])
    );
    const started = events.find(({ event }) => event === "start")!;
    const servedPath = started.dbPath!;
    expect(processExists(started.descendantPid!)).toBe(false);
    expect(servedPath).not.toBe(":memory:");
    expect(fs.existsSync(path.dirname(servedPath))).toBe(false);
    expect(result.stdout).toContain("ignoring caller ALLOS_DB_PATH");
    expect(result.stdout).toContain("scratch DB and sidecars removed");
  });

  it("does not accept an unrelated prebound 200 server as its spawned instance", async () => {
    const dir = makeTmpDir("seed-shape-prebound-sentinel");
    const fakeBin = path.join(dir, "bin");
    const receipt = path.join(dir, "server-receipt.jsonl");
    writeFakeNpm(fakeBin);
    const port = await availablePort();
    const sentinelReady = path.join(dir, "sentinel-ready");
    const sentinelScript = path.join(dir, "sentinel.cjs");
    fs.writeFileSync(
      sentinelScript,
      `const fs = require("node:fs");
const http = require("node:http");
const server = http.createServer((_request, response) => { response.statusCode = 200; response.end("unrelated sentinel"); });
server.listen(Number(process.env.PORT), "127.0.0.1", () => fs.writeFileSync(process.env.SENTINEL_READY, "ready"));
process.on("SIGTERM", () => { server.close(() => process.exit(0)); server.closeAllConnections(); setTimeout(() => process.exit(0), 1000); });
`
    );
    const sentinel = spawn(process.execPath, [sentinelScript], {
      env: {
        ...process.env,
        PORT: String(port),
        SENTINEL_READY: sentinelReady,
      },
      stdio: "ignore",
    });
    await waitFor(() => fs.existsSync(sentinelReady), "sentinel did not bind");
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(repo, "scripts", "ux-walkthrough.mjs"), "--serve", "pages"],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
            FAKE_SERVER_RECEIPT: receipt,
            UX_BASE: `http://127.0.0.1:${port}`,
            UX_CHROMIUM: path.join(dir, "missing-chromium"),
            UX_SHOTS: path.join(dir, "shots"),
            UX_SEED: "",
            SEED_RNG: "",
            SEED_PERSONA: "",
          },
        }
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("server ready");
      expect(result.stderr).toContain("dev server exited before readiness");
      expect(readServerReceipts(receipt).map(({ event }) => event)).toContain(
        "listener-error"
      );
      const claimed = result.stdout.match(
        /claimed private scratch DB path: (.+\/allos\.db)/
      )?.[1];
      expect(claimed).toBeTruthy();
      expect(fs.existsSync(path.dirname(claimed!))).toBe(false);
    } finally {
      sentinel.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        sentinel.once("exit", () => resolve())
      );
    }
  });

  it("routes SIGTERM through descendant and exact scratch-directory cleanup", async () => {
    const dir = makeTmpDir("seed-shape-signal-cleanup");
    const fakeBin = path.join(dir, "bin");
    const receipt = path.join(dir, "server-receipt.jsonl");
    writeFakeNpm(fakeBin);
    const port = await availablePort();
    const child = spawn(
      process.execPath,
      [path.join(repo, "scripts", "ux-walkthrough.mjs"), "--serve", "pages"],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          FAKE_SERVER_RECEIPT: receipt,
          UX_BASE: `http://127.0.0.1:${port}`,
          UX_SHOTS: path.join(dir, "shots"),
          UX_CHROMIUM: path.join(dir, "missing-chromium"),
          UX_SEED: "",
          SEED_RNG: "",
          SEED_PERSONA: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    await waitFor(
      () => readServerReceipts(receipt).some(({ event }) => event === "start"),
      `descendant did not start\n${stdout}\n${stderr}`
    );
    const started = readServerReceipts(receipt).find(
      ({ event }) => event === "start"
    )!;
    const servedPath = started.dbPath!;
    expect(fs.existsSync(`${servedPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${servedPath}-shm`)).toBe(true);
    child.kill("SIGTERM");
    const exit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    expect(exit).toEqual({ code: 143, signal: null });
    await waitFor(
      () => !processExists(started.descendantPid!),
      "descendant listener survived harness SIGTERM"
    );
    expect(fs.existsSync(path.dirname(servedPath))).toBe(false);
    expect(fs.existsSync(`${servedPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${servedPath}-shm`)).toBe(false);
    expect(stdout).toContain("SIGTERM received; cleaning up");
    expect(stdout).toContain("scratch DB and sidecars removed");
  });
});
