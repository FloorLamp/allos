// The fs half of the JSONL log sinks (#1883): the self-trim must be atomic
// against a concurrent appender, because the `allos-notify` sidecar is a
// separate OS process appending to the same errors.jsonl the web app trims.
//
// Everything here runs inside a throwaway tmp dir — no repo data/logs, no DB, no
// network. The last case spawns real child processes (the bug IS cross-process),
// so it gets its own generous timeout.

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  appendJsonlLine,
  clearJsonlFile,
  type JsonlBudgets,
} from "../jsonl-log-file";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// Trim on every append, but keep everything: any line missing at the end was
// lost to the read-modify-write race, not to the budget.
const KEEP_ALL: JsonlBudgets = {
  maxBytes: 1,
  keepLines: 1_000_000,
  keepBytes: 10 * 1024 * 1024,
};

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-jsonl-"));
  return path.join(dir, name);
}

function line(i: number): string {
  return JSON.stringify({ id: `e${i}`, detail: "x".repeat(50) }) + "\n";
}

function readLines(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendJsonlLine self-trim (#1883)", () => {
  it("appends without touching the file when it is under budget", () => {
    const file = tmpFile("errors.jsonl");
    const budgets: JsonlBudgets = {
      maxBytes: 1024 * 1024,
      keepLines: 10,
      keepBytes: 1024,
    };
    for (let i = 0; i < 5; i++) appendJsonlLine(file, line(i), budgets);
    expect(readLines(file)).toHaveLength(5);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["errors.jsonl"]);
  });

  it("trims to the newest tail and leaves a well-formed file", () => {
    const file = tmpFile("errors.jsonl");
    const budgets: JsonlBudgets = {
      maxBytes: 400,
      keepLines: 3,
      keepBytes: 400,
    };
    for (let i = 0; i < 12; i++) appendJsonlLine(file, line(i), budgets);
    const kept = readLines(file);
    expect(kept.length).toBeLessThanOrEqual(3);
    // Newest survive, every line still parses (no half-written record), and the
    // file ends on a line boundary.
    expect(JSON.parse(kept[kept.length - 1]).id).toBe("e11");
    for (const l of kept) expect(() => JSON.parse(l)).not.toThrow();
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    // No temp file, no lock left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["errors.jsonl"]);
  });

  it("an append that completed before the trim's read always survives it", () => {
    const file = tmpFile("errors.jsonl");
    for (let i = 0; i < 30; i++) appendJsonlLine(file, line(i), KEEP_ALL);
    expect(readLines(file)).toHaveLength(30);
    expect(readLines(file).map((l) => JSON.parse(l).id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `e${i}`)
    );
  });

  it("rescues an append that lands between the snapshot and the swap", () => {
    // The seam: an OUTSIDE appender (one that bypassed this module, i.e. the
    // worst case) writes while the trim is building its temp file. The old bare
    // readFileSync → writeFileSync overwrote that line; the pre-rename catch-up
    // carries it over instead.
    const file = tmpFile("errors.jsonl");
    for (let i = 0; i < 4; i++) appendJsonlLine(file, line(i), KEEP_ALL);

    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.writeFileSync>
    ) => {
      const out = realWrite(...args);
      spy.mockRestore(); // fire exactly once, for the temp-file write
      fs.appendFileSync(file, line(999));
      return out;
    }) as typeof fs.writeFileSync);

    appendJsonlLine(file, line(4), KEEP_ALL);

    const ids = readLines(file).map((l) => JSON.parse(l).id);
    expect(ids).toContain("e999"); // the interleaved append is not discarded
    expect(ids).toContain("e4");
    expect(ids).toHaveLength(6);
  });

  it("never exposes a truncated file to a concurrent reader", () => {
    const file = tmpFile("errors.jsonl");
    for (let i = 0; i < 6; i++) appendJsonlLine(file, line(i), KEEP_ALL);
    const before = fs.readFileSync(file, "utf8");

    // Sample what a reader would see at the last instant before the swap: with
    // an in-place rewrite that is a half-truncated file; with rename it is still
    // the complete previous version.
    const realRename = fs.renameSync;
    let observed = "";
    vi.spyOn(fs, "renameSync").mockImplementation(((
      ...args: Parameters<typeof fs.renameSync>
    ) => {
      observed = fs.readFileSync(file, "utf8");
      return realRename(...args);
    }) as typeof fs.renameSync);

    appendJsonlLine(file, line(6), KEEP_ALL);
    expect(observed).toBe(before + line(6));
    expect(readLines(file)).toHaveLength(7);
  });

  it("breaks a stale lock instead of skipping the trim forever", () => {
    const file = tmpFile("errors.jsonl");
    for (let i = 0; i < 8; i++) appendJsonlLine(file, line(i), KEEP_ALL);
    // A holder that died mid-trim (SIGKILL / OOM / container stop) leaves its
    // lockfile behind. Age it past the staleness horizon minus a beat, so the
    // acquire loop demonstrably WAITS and then breaks it.
    const lock = `${file}.lock`;
    fs.closeSync(fs.openSync(lock, "wx"));
    const aged = new Date(Date.now() - 29_800);
    fs.utimesSync(lock, aged, aged);

    appendJsonlLine(file, line(8), KEEP_ALL);

    expect(readLines(file)).toHaveLength(9);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("appends anyway (and skips the trim) when the lock can't be taken", () => {
    // Losing a trim is harmless — the next append retries it. Losing an event is
    // not, so a contended lock must never cost a line.
    const file = tmpFile("errors.jsonl");
    const budgets: JsonlBudgets = {
      maxBytes: 10,
      keepLines: 1,
      keepBytes: 200,
    };
    for (let i = 0; i < 3; i++) appendJsonlLine(file, line(i), KEEP_ALL);
    const lock = `${file}.lock`;
    fs.closeSync(fs.openSync(lock, "wx")); // fresh: held, not stale

    appendJsonlLine(file, line(3), budgets);

    expect(readLines(file)).toHaveLength(4); // the append landed
    fs.unlinkSync(lock);
    appendJsonlLine(file, line(4), budgets); // …and the next one trims
    expect(readLines(file)).toHaveLength(1);
  }, 10_000);

  it("clears under the same lock as appends", () => {
    const file = tmpFile("errors.jsonl");
    for (let i = 0; i < 3; i++) appendJsonlLine(file, line(i), KEEP_ALL);
    clearJsonlFile(file);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["errors.jsonl"]);
  });
});

describe("two processes on one DATA_DIR (#1883)", () => {
  it("loses no line when a sidecar appends while the app trims", async () => {
    // The real topology from docker-compose.yml: the app and the allos-notify
    // sidecar are separate OS processes on the same bind mount. Budgets force a
    // full rewrite on EVERY append, so the writers are colliding constantly;
    // with the old read-modify-write this drops lines in both directions.
    const file = tmpFile("errors.jsonl");
    const WRITERS = 3;
    const PER_WRITER = 25;
    const startAt = Date.now() + 1500; // start all writers on the same beat

    const child = path.join(path.dirname(file), "writer.mjs");
    fs.writeFileSync(
      child,
      `
import { appendJsonlLine } from ${JSON.stringify(path.join(REPO_ROOT, "lib", "jsonl-log-file.ts"))};
const [file, tag, startAt, count] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
for (let i = 0; i < Number(count); i++) {
  appendJsonlLine(file, JSON.stringify({ id: tag + "-" + i }) + "\\n", {
    maxBytes: 1,
    keepLines: 1000000,
    keepBytes: 10 * 1024 * 1024,
  });
}
`
    );

    const runs = Array.from({ length: WRITERS }, (_, w) => {
      const proc = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          child,
          file,
          `w${w}`,
          String(startAt),
          String(PER_WRITER),
        ],
        { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += String(d)));
      return new Promise<void>((resolve, reject) => {
        proc.on("error", reject);
        proc.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`writer ${w}: ${stderr}`))
        );
      });
    });
    await Promise.all(runs);

    const ids = readLines(file).map((l) => JSON.parse(l).id);
    expect(new Set(ids).size).toBe(WRITERS * PER_WRITER);
    for (let w = 0; w < WRITERS; w++) {
      for (let i = 0; i < PER_WRITER; i++) expect(ids).toContain(`w${w}-${i}`);
    }
  }, 60_000);
});
