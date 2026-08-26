import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LONG_NAMES } from "../../scripts/seed-long-names";
import {
  allocateUxServedDb,
  assertUxServedDbOwned,
  assertUxServedDbUnused,
  cleanupUxServedDb,
} from "../../scripts/ux-served-db.mjs";
import { makeTmpDir } from "../__tests__/tmp-dir";
import { migratedDb } from "./migrated-db";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..");

type Witnesses = {
  qualifiedEncounter: number;
  longIntake: number;
  longLab: number;
  longCondition: number;
};

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

function seedAndRead(shape: "baseline" | "dirty"): Witnesses {
  const dbPath = path.join(makeTmpDir(`seed-shape-${shape}`), "allos.db");
  const result = runSeed(dbPath, shape);
  expect(result.status, result.stderr || result.stdout).toBe(0);

  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (sql: string, value: string) =>
      (db.prepare(sql).get(value) as { count: number }).count;
    return {
      qualifiedEncounter: count(
        "SELECT COUNT(*) AS count FROM encounters WHERE profile_id = 1 AND diagnoses = ?",
        "Encounter for screening for malignant neoplasm of colon; Encounter for screening for malignant neoplasm of colon - Primary"
      ),
      longIntake: count(
        "SELECT COUNT(*) AS count FROM intake_items WHERE profile_id = 1 AND name = ?",
        LONG_NAMES.intakeItem
      ),
      longLab: count(
        "SELECT COUNT(*) AS count FROM medical_records WHERE profile_id = 1 AND category = 'lab' AND name = ?",
        LONG_NAMES.clinicalResult
      ),
      longCondition: count(
        "SELECT COUNT(*) AS count FROM conditions WHERE profile_id = 1 AND name = ?",
        LONG_NAMES.condition
      ),
    };
  } finally {
    db.close();
  }
}

function migratedFile(
  label: string,
  mutate: (database: Database.Database) => void
): string {
  const dbPath = path.join(
    makeTmpDir(`seed-shape-${label.replaceAll("_", "-")}`),
    "allos.db"
  );
  const source = migratedDb();
  try {
    mutate(source);
    fs.writeFileSync(dbPath, source.serialize());
  } finally {
    source.close();
  }
  return dbPath;
}

describe("named dirty seed data", () => {
  it("writes the dirty witnesses through seed.ts while the pinned baseline writes none", () => {
    expect(seedAndRead("dirty")).toEqual({
      qualifiedEncounter: 1,
      longIntake: 1,
      longLab: 1,
      longCondition: 1,
    });
    expect(seedAndRead("baseline")).toEqual({
      qualifiedEncounter: 0,
      longIntake: 0,
      longLab: 0,
      longCondition: 0,
    });
  }, 30_000);

  it("checks the dirty witnesses again at the harness child boundary", () => {
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
  }, 30_000);

  it("keeps a stale caller DB outside every served census shape", () => {
    const dir = makeTmpDir("seed-shape-stale");
    const dbPath = path.join(dir, "allos.db");
    const baseline = runSeed(dbPath, "baseline");
    expect(baseline.status, baseline.stderr || baseline.stdout).toBe(0);

    const directDirty = runSeed(dbPath, "dirty");
    expect(directDirty.status).not.toBe(0);
    expect(directDirty.stderr).toContain(
      "Database already has data — refusing named seed shape dirty"
    );

    const before = fs.readFileSync(dbPath);
    const allocations = [
      allocateUxServedDb(dir),
      allocateUxServedDb(dir),
      allocateUxServedDb(dir),
      allocateUxServedDb(dir),
    ];
    try {
      expect(new Set(allocations.map(({ dbPath }) => dbPath)).size).toBe(4);
      for (const allocation of allocations) {
        expect(allocation.dbPath).not.toBe(dbPath);
        assertUxServedDbOwned(allocation);
        assertUxServedDbUnused(allocation);
      }
      expect(fs.readFileSync(dbPath)).toEqual(before);
    } finally {
      for (const allocation of allocations) cleanupUxServedDb(allocation);
    }
  }, 30_000);

  it("does not classify arbitrary rows, schema, or bootstrap metadata as fresh", () => {
    const dbPath = migratedFile("arbitrary-stale-data", (database) => {
      database
        .prepare(
          "INSERT INTO conditions (profile_id, name, status) VALUES (1, 'Stale sentinel condition', 'active')"
        )
        .run();
      database.exec(
        "CREATE TABLE arbitrary_stale_payload (value TEXT); INSERT INTO arbitrary_stale_payload VALUES ('preserve me')"
      );
      database
        .prepare(
          "INSERT INTO settings (key, value) VALUES ('stale-bootstrap-metadata', 'yes')"
        )
        .run();
    });
    const before = fs.readFileSync(dbPath);
    const allocation = allocateUxServedDb(path.dirname(dbPath));
    try {
      expect(allocation.dbPath).not.toBe(dbPath);
      expect(fs.lstatSync(allocation.dbPath).isFile()).toBe(true);
      assertUxServedDbUnused(allocation);
      expect(fs.readFileSync(dbPath)).toEqual(before);
    } finally {
      cleanupUxServedDb(allocation);
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
  }, 30_000);

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
          UX_SEED: "dirty",
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
  }, 40_000);

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
            UX_SEED: "dirty",
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
  }, 40_000);

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
          UX_SEED: "dirty",
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
  }, 40_000);
});
