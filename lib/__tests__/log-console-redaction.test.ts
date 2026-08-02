// The console echo in lib/log.ts must get the same secret redaction the
// persisted copies get (#1882) — `docker logs` is a broader audience than the
// admin-only errors.jsonl viewer. Pure: the sink is console, captured with a
// spy, and lib/error-log.ts is never imported here, so no error sink is
// registered and nothing touches data/logs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../log";
import { redactSecrets } from "../error-log-format";

const log = createLogger("test");

// Obviously fake, LOW-ENTROPY placeholders. redactSecrets keys off the field
// NAME (and the `Bearer ` prefix), never the value's shape, so a structured
// stand-in proves exactly the same thing as a realistic-looking one — while
// keeping the repo's secret scanner out of a test fixture.
const FAKE_TOKEN = "xxxx-xxxx-xxxx";
const FAKE_PASSWORD = "pw-xxxx-xxxx";

let lines: string[] = [];
const spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  lines = [];
  process.env.LOG_LEVEL = "debug";
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  spies.push(vi.spyOn(console, "error").mockImplementation(capture));
  spies.push(vi.spyOn(console, "log").mockImplementation(capture));
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  delete process.env.LOG_FORMAT;
  delete process.env.LOG_LEVEL;
});

function only(): string {
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe("console echo redaction (#1882)", () => {
  it("masks a Bearer token in a field, in the JSON format", () => {
    process.env.LOG_FORMAT = "json";
    log.error("request failed", {
      authorization: `Bearer ${FAKE_TOKEN}`,
      status: 401,
    });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    const parsed = JSON.parse(line);
    expect(String(parsed.authorization)).toContain("***");
    // Untouched siblings keep their value AND their type.
    expect(parsed.status).toBe(401);
    expect(parsed.msg).toBe("request failed");
    expect(parsed.scope).toBe("test");
  });

  it("masks a bare token that only the KEY marks as sensitive", () => {
    // The whole point of masking the serialized bag rather than each value on
    // its own: the value alone looks like any other string.
    process.env.LOG_FORMAT = "json";
    log.warn("token refresh", { access_token: FAKE_TOKEN });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(line).access_token).toBe("***");
  });

  it("masks in the text format too", () => {
    process.env.LOG_FORMAT = "text";
    log.error("login failed", { password: FAKE_PASSWORD, user: "ada" });
    const line = only();
    expect(line).not.toContain(FAKE_PASSWORD);
    expect(line).toContain("password=***");
    expect(line).toContain("user=ada");
  });

  it("masks a secret quoted in the message itself", () => {
    process.env.LOG_FORMAT = "text";
    log.error(`upstream said: authorization: Bearer ${FAKE_TOKEN}`);
    expect(only()).not.toContain(FAKE_TOKEN);
  });

  it("masks a secret inside a thrown Error's message", () => {
    process.env.LOG_FORMAT = "json";
    log.error("sync failed", {
      err: new Error(`POST /v1 rejected (token=${FAKE_TOKEN})`),
    });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    expect(String(JSON.parse(line).err)).toContain("token=***");
  });

  it("leaves a bag with nothing secret-looking completely untouched", () => {
    process.env.LOG_FORMAT = "json";
    log.info("sync ok", { inserted: 3, updated: 0, provider: "oura" });
    const parsed = JSON.parse(only());
    expect(parsed.inserted).toBe(3);
    expect(parsed.updated).toBe(0);
    expect(parsed.provider).toBe("oura");
  });

  it("is stable on already-redacted input (recordAiEvent's echo)", () => {
    // lib/ai-log.ts redacts detail/error BEFORE echoing them through the logger,
    // so the console pass sees pre-masked text. Composition must be a no-op, not
    // a second round of masking.
    process.env.LOG_FORMAT = "json";
    const detail = redactSecrets(`provider refused: token=${FAKE_TOKEN}`);
    const error = redactSecrets(`authorization: Bearer ${FAKE_TOKEN}`);
    log.error("ai call failed", { detail, error });
    const parsed = JSON.parse(only());
    expect(parsed.detail).toBe(detail);
    expect(parsed.error).toBe(error);
  });

  it("redactSecrets is idempotent, so double application cannot drift", () => {
    const samples = [
      `authorization: Bearer ${FAKE_TOKEN}`,
      `password=${FAKE_PASSWORD}`,
      JSON.stringify({ access_token: FAKE_TOKEN }),
      "nothing sensitive here",
      `cookie: session=${FAKE_TOKEN}`,
    ];
    for (const s of samples) {
      const once = redactSecrets(s);
      expect(redactSecrets(once)).toBe(once);
    }
  });

  it("keeps the JSON line parseable when masking would break the shape", () => {
    // A sensitive key holding a NUMBER masks to an unquoted `***`, which is not
    // valid JSON — the fallback emits the masked text as one string field rather
    // than shipping a broken line to a log aggregator.
    process.env.LOG_FORMAT = "json";
    log.error("session expired", { session: 42, token: FAKE_TOKEN });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    const parsed = JSON.parse(line); // must not throw
    expect(JSON.stringify(parsed)).toContain("***");
  });

  it("still honours the level threshold", () => {
    process.env.LOG_LEVEL = "warn";
    process.env.LOG_FORMAT = "json";
    log.info("quiet", { token: FAKE_TOKEN });
    expect(lines).toHaveLength(0);
  });
});
