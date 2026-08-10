// The fs half of the notify tick sink (#2209): it must redact exactly as
// recordErrorEvent does, stamp the run/profile a line belongs to, stay BEST-EFFORT
// under a failing disk, and — the #1883 invariant, now extended to a third sink —
// lose no line when a second process appends while this one trims.
//
// Runs entirely inside a throwaway tmp dir. The sink resolves its path from
// process.cwd() (the same mechanism the e2e harness uses to give each worker its own
// logs), so the suite chdirs into the tmp dir and restores afterwards. No DB, no
// network. The last case spawns real child processes, so it gets its own timeout.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseNotifyLine, type NotifyEvent } from "../notify-log-format";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const ORIGINAL_CWD = process.cwd();
let tmpDir: string;
let logPath: string;

// Imported AFTER the chdir so NOTIFY_LOG_PATH resolves inside the tmp dir.
let sink: typeof import("../notify-log");
let logger: typeof import("../log");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-notify-log-"));
  process.chdir(tmpDir);
  sink = await import("../notify-log");
  logger = await import("../log");
  logPath = sink.NOTIFY_LOG_PATH;
});

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
});

afterEach(() => {
  vi.restoreAllMocks();
  sink.clearNotifyLog();
  sink.endNotifyRun();
});

// The file's raw bytes, or "" when it was never created. `clearNotifyLog()`
// truncates rather than unlinks (so the path stays put for the next append), so
// "nothing was written" is an EMPTY file, not an absent one.
function rawLog(): string {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

function lines(): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const l of fs.readFileSync(logPath, "utf8").split("\n")) {
    const e = parseNotifyLine(l);
    if (e) out.push(e);
  }
  return out;
}

describe("the notify sink writes only what it admits (#2209)", () => {
  it("persists an admitted-scope line", () => {
    sink.recordNotifyEvent({
      level: "info",
      scope: "notify",
      msg: "nothing due",
      fields: { profile: 3, slot: "workout" },
    });
    const got = lines();
    expect(got).toHaveLength(1);
    expect(got[0].message).toBe("nothing due");
    expect(got[0].scope).toBe("notify");
    expect(got[0].profileId).toBe(3);
  });

  it("writes nothing at all for a scope it does not admit", () => {
    sink.recordNotifyEvent({
      level: "error",
      scope: "ai",
      msg: "ai call failed",
    });
    sink.recordNotifyEvent({ level: "info", scope: "import", msg: "imported" });
    // Not one byte: an unadmitted line must not reach the file at all.
    expect(rawLog()).toBe("");
  });

  it("drops debug even in an admitted scope", () => {
    sink.recordNotifyEvent({
      level: "debug",
      scope: "notify",
      msg: "internal trace",
    });
    expect(rawLog()).toBe("");
  });
});

describe("redaction parity with recordErrorEvent (#2209 constraint 2)", () => {
  // redactSecrets() keys off the FIELD NAME, so an obviously-fake low-entropy
  // placeholder proves the same behavior as a realistic value would — and keeps a
  // credential-shaped string out of the repo entirely.
  it("masks a secret-looking value in the MESSAGE", () => {
    sink.recordNotifyEvent({
      level: "warn",
      scope: "notify",
      msg: "telegram refused: token=abc",
    });
    const [e] = lines();
    expect(e.message).toContain("token=***");
    expect(e.message).not.toContain("abc");
  });

  it("masks a secret-looking value in the FIELDS, identically", () => {
    sink.recordNotifyEvent({
      level: "warn",
      scope: "notify",
      msg: "dispatch failed",
      fields: { profile: 1, authorization: "abc" },
    });
    const [e] = lines();
    expect(e.detail).toBeDefined();
    expect(e.detail).toContain("***");
    expect(e.detail).not.toContain("abc");
  });

  it("caps a runaway message rather than writing it whole", () => {
    sink.recordNotifyEvent({
      level: "info",
      scope: "notify",
      msg: "x".repeat(5000),
    });
    const [e] = lines();
    expect(e.message.length).toBeLessThan(1200);
    expect(e.message).toContain("chars)");
  });
});

describe("run and profile stamping (#2209)", () => {
  it("stamps the run id the tick minted onto every line", () => {
    const run = sink.beginNotifyRun();
    sink.recordNotifyEvent({ level: "info", scope: "notify", msg: "a" });
    sink.recordNotifyEvent({ level: "info", scope: "notify", msg: "b" });
    const got = lines();
    expect(got.map((e) => e.runId)).toEqual([run, run]);
  });

  it("mints a DIFFERENT id for the next run", () => {
    const first = sink.beginNotifyRun();
    const second = sink.beginNotifyRun();
    expect(second).not.toBe(first);
  });

  it("leaves runId null outside a run rather than inventing one", () => {
    sink.recordNotifyEvent({
      level: "info",
      scope: "notify",
      msg: "poll tick",
    });
    expect(lines()[0].runId).toBeNull();
  });

  it("prefers the OPEN tick scope's subject over the line's own field", async () => {
    const { runInTickScope } = await import("../tick-cache");
    sink.beginNotifyRun();
    await runInTickScope(
      async () => {
        sink.recordNotifyEvent({
          level: "info",
          scope: "notify",
          msg: "nothing due",
          // A stale/wrong field must never beat the scope that is actually open.
          fields: { profile: 99 },
        });
      },
      { profileId: 7 }
    );
    expect(lines()[0].profileId).toBe(7);
  });

  it("leaves profileId null when nothing attributes the line", () => {
    sink.beginNotifyRun();
    sink.recordNotifyEvent({
      level: "info",
      scope: "notify",
      msg: "tick started",
      fields: { profiles: 4 },
    });
    expect(lines()[0].profileId).toBeNull();
  });
});

describe("the sink is best-effort (#2209 constraint 1)", () => {
  it("does not throw when the append fails", () => {
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    // A tick that cannot write its diary must still deliver its reminders.
    expect(() =>
      sink.recordNotifyEvent({
        level: "info",
        scope: "notify",
        msg: "nothing due",
      })
    ).not.toThrow();
  });

  it("does not throw when the log directory cannot be created", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    expect(() =>
      sink.recordNotifyEvent({
        level: "warn",
        scope: "notifications",
        msg: "no configured channels; nothing sent",
      })
    ).not.toThrow();
  });

  it("survives a field bag that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = { profile: 1 };
    cyclic.self = cyclic;
    expect(() =>
      sink.recordNotifyEvent({
        level: "info",
        scope: "notify",
        msg: "nothing due",
        fields: cyclic,
      })
    ).not.toThrow();
  });
});

describe("the funnel is wired (#2209)", () => {
  it("createLogger('notify') reaches the sink through the scope registration", () => {
    // Proves the registration in lib/notify-log.ts, not just the function: an
    // ordinary tick call site must land in the file with no extra ceremony.
    const log = logger.createLogger("notify");
    log.info("already sent today", { profile: 2, slot: "digest" });
    const got = lines();
    expect(got).toHaveLength(1);
    expect(got[0].message).toBe("already sent today");
    expect(got[0].profileId).toBe(2);
  });
});

describe("two processes on one DATA_DIR, third sink (#1883 extended to #2209)", () => {
  it("loses no line when a second process appends while this one trims", async () => {
    // The real topology: the app and the allos-notify sidecar are separate OS
    // processes on the same bind mount, and BOTH now write notify.jsonl. This
    // asserts the sink actually routes through the shared append+trim chokepoint —
    // a future edit that reached for a bare appendFileSync would fail here.
    const WRITERS = 3;
    const PER_WRITER = 20;
    const startAt = Date.now() + 1500; // start every writer on the same beat

    const child = path.join(tmpDir, "notify-writer.mjs");
    fs.writeFileSync(
      child,
      `
import { appendJsonlLine } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "lib", "jsonl-log-file.ts")).href)};
const [file, tag, startAt, count] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
for (let i = 0; i < Number(count); i++) {
  appendJsonlLine(file, JSON.stringify({
    id: tag + "-" + i,
    time: new Date().toISOString(),
    level: "info",
    scope: "notify",
    message: "nothing due",
  }) + "\\n", { maxBytes: 1, keepLines: 1000000, keepBytes: 10 * 1024 * 1024 });
}
`
    );

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const runs = Array.from({ length: WRITERS }, (_, w) => {
      const proc = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          child,
          logPath,
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

    const ids = lines().map((e) => e.id);
    expect(new Set(ids).size).toBe(WRITERS * PER_WRITER);
    for (let w = 0; w < WRITERS; w++) {
      for (let i = 0; i < PER_WRITER; i++) expect(ids).toContain(`w${w}-${i}`);
    }
  }, 60_000);
});
