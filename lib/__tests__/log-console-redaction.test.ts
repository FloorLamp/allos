// The console echo in lib/log.ts must get the same secret redaction the
// persisted copies get (#1882) — `docker logs` is a broader audience than the
// admin-only errors.jsonl viewer. Pure: the sink is console, captured with a
// spy, and lib/error-log.ts is never imported here, so no error sink is
// registered and nothing touches data/logs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../log";
import { redactSecrets } from "../error-log-format";

const log = createLogger("test");

// Obviously fake, LOW-ENTROPY placeholders. The rules these fixtures exercise
// key off the field NAME and the `Bearer ` prefix, so a structured stand-in
// proves exactly the same thing as a realistic-looking one — while keeping the
// repo's secret scanner out of a test fixture. (redactSecrets also matches
// credential SHAPES in URLs and after `Basic`, covered in
// error-log-format.test.ts.)
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
    // The line has to stay parseable for a log aggregator. Since #2966 the
    // masking happens inside the JSON.stringify replacer, so the output is
    // valid JSON by construction — the replacer substitutes whole values and
    // can no longer emit an unquoted `***` mid-object. A sensitive key holding
    // a NUMBER is left alone on top of that (#2938 — a count is not a
    // credential) while the string beside it is still masked.
    process.env.LOG_FORMAT = "json";
    log.error("session expired", { session: 42, token: FAKE_TOKEN });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    const parsed = JSON.parse(line); // must not throw
    expect(JSON.stringify(parsed)).toContain("***");
    // The sibling field survives intact rather than collapsing with the bag.
    expect(parsed.session).toBe(42);
  });

  it("still honours the level threshold", () => {
    process.env.LOG_LEVEL = "warn";
    process.env.LOG_FORMAT = "json";
    log.info("quiet", { token: FAKE_TOKEN });
    expect(lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #2966: redactBag redacts DURING serialization, not after it.
//
// These are the cases that separate the two orderings. Before the fix redactBag
// stringified the whole bag and redacted the resulting TEXT, which survived only
// because the key rule happens to match the single-escaped `\"key\":` form that
// one round of JSON.stringify produces. That coincidence is what these tests
// exist to stop depending on — narrow the key rule for any other reason and the
// two-level case below is the one that says so.

describe("redactBag redacts before escaping (#2966)", () => {
  it("masks a secret two JSON levels deep, which escaping used to hide", () => {
    // The falsifier for escape-then-redact, and a leak that was live on main:
    // an upstream error body carried in a field, where the upstream had itself
    // embedded a serialized payload. The OLD ordering left
    // `\\\"access_token\\\"` — two backslashes — and the key rule matches at
    // most one. No widening of that rule reaches this; only the ordering does,
    // because the replacer sees the field's own UNESCAPED text.
    process.env.LOG_FORMAT = "json";
    const upstream = JSON.stringify({ access_token: FAKE_TOKEN });
    log.error("sync failed", {
      body: JSON.stringify({ inner: upstream }),
      profileId: 7,
    });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    // And the rest of the line still reads as a log line, not as one blob.
    expect(JSON.parse(line).profileId).toBe(7);
  });

  it("masks a sensitive key holding a whole object", () => {
    process.env.LOG_FORMAT = "json";
    log.error("refresh failed", {
      credentials: { access_token: FAKE_TOKEN, refresh_token: FAKE_TOKEN },
      profileId: 7,
    });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(line).credentials).toBe("***");
  });

  it("masks a secret nested under ordinary keys", () => {
    process.env.LOG_FORMAT = "json";
    log.error("upstream rejected", {
      response: { data: { access_token: FAKE_TOKEN } },
      profileId: 7,
    });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(line).response.data.access_token).toBe("***");
  });

  it("never collapses the whole bag into one opaque string", () => {
    // The other half of #2966. An over-masked field used to invalidate the JSON,
    // and the re-parse failure took EVERY field with it — `profileId` included —
    // into `{redacted: "…"}`. An operator cannot act on that, which is a defect
    // in the same way a leak is. Every key here is sensitive by NAME, and none
    // of them can hold a credential.
    process.env.LOG_FORMAT = "json";
    log.error("token check", {
      sessionCount: 42,
      tokenValid: false,
      token: null,
      secretRatio: 1.5,
      profileId: 7,
    });
    const parsed = JSON.parse(only());
    expect(parsed.redacted).toBeUndefined();
    expect(parsed.profileId).toBe(7);
    // A number, boolean or null keeps BOTH its value and its type.
    expect(parsed.sessionCount).toBe(42);
    expect(parsed.tokenValid).toBe(false);
    expect(parsed.token).toBeNull();
    expect(parsed.secretRatio).toBe(1.5);
  });

  it("still masks a string sibling of those untouched scalars", () => {
    // The type gate must not become a hole: same shape of key, string value.
    process.env.LOG_FORMAT = "json";
    log.error("token check", { sessionCount: 42, sessionToken: FAKE_TOKEN });
    const line = only();
    expect(line).not.toContain(FAKE_TOKEN);
    const parsed = JSON.parse(line);
    expect(parsed.sessionToken).toBe("***");
    expect(parsed.sessionCount).toBe(42);
  });

  it("leaves an unmatched bag's values and types alone", () => {
    process.env.LOG_FORMAT = "json";
    log.info("sync ok", { inserted: 3, ratio: 0.5, ok: true, note: null });
    const parsed = JSON.parse(only());
    expect(parsed.inserted).toBe(3);
    expect(parsed.ratio).toBe(0.5);
    expect(parsed.ok).toBe(true);
    expect(parsed.note).toBeNull();
  });
});
