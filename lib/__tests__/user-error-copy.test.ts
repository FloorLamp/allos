import { describe, expect, it } from "vitest";
import {
  classifyUserError,
  userErrorCopy,
  UserFacingError,
} from "@/lib/user-error-copy";
import { backfillErrorMessage } from "@/lib/integrations/backfill-error";

// The string that started #3198: a SQLite internal rendered verbatim on a settings
// page addressed to somebody tracking their health.
const OBSERVED_LEAK =
  "UNIQUE constraint failed: activity_segment_efforts.profile_id, " +
  "activity_segment_efforts.source, activity_segment_efforts.external_id";

// Vocabulary no classifier output may ever contain, whatever it was handed.
const MACHINE_WORDS = [
  /constraint/i,
  /\bundefined\b/,
  /\bnull\b/,
  /SQLITE_/,
  /activity_segment_efforts/,
  /\bat .*\.ts:\d+/,
  /\bTypeError\b/,
  /Error:/,
];

function sqliteError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("classifyUserError reads the spellings this repo actually meets", () => {
  it("a better-sqlite3 constraint failure is a write failure, by message and by code", () => {
    expect(classifyUserError(new Error(OBSERVED_LEAK))).toBe("write");
    expect(
      classifyUserError(sqliteError("stuff", "SQLITE_CONSTRAINT_UNIQUE"))
    ).toBe("write");
    expect(
      classifyUserError(
        sqliteError(
          "FOREIGN KEY constraint failed",
          "SQLITE_CONSTRAINT_FOREIGNKEY"
        )
      )
    ).toBe("write");
  });

  it("a locked database is transient, not a write failure", () => {
    expect(
      classifyUserError(sqliteError("database is locked", "SQLITE_BUSY"))
    ).toBe("busy");
  });

  it("network and upstream failures are their own family", () => {
    for (const message of [
      "fetch failed",
      "getaddrinfo ENOTFOUND www.strava.com",
      "read ECONNRESET",
      "socket hang up",
      "The operation was aborted due to timeout",
    ]) {
      expect(classifyUserError(new Error(message)), message).toBe("upstream");
    }
    expect(
      classifyUserError(
        Object.assign(new Error("timed out"), { name: "TimeoutError" })
      )
    ).toBe("upstream");
  });

  it("anything else is unknown, including a thrown non-Error", () => {
    expect(classifyUserError(new TypeError("x is not a function"))).toBe(
      "unknown"
    );
    expect(classifyUserError("something blew up")).toBe("unknown");
    expect(classifyUserError(undefined)).toBe("unknown");
  });

  it("an authored sentence is recognized as authored", () => {
    expect(
      classifyUserError(new UserFacingError("A provider needs a name."))
    ).toBe("authored");
  });
});

describe("userErrorCopy returns house copy and never raw text", () => {
  const ctx = { doing: "finish this backfill" };

  it("the observed leak becomes the write-failure sentence", () => {
    expect(userErrorCopy(new Error(OBSERVED_LEAK), ctx)).toBe(
      "Couldn't finish this backfill. It's a bug on our side."
    );
  });

  it("unknown garbage becomes the generic sentence", () => {
    expect(userErrorCopy("  garbage 42", ctx)).toBe(
      "Couldn't finish this backfill."
    );
  });

  it("a transient failure is the only family that says 'Try again.'", () => {
    // copy.md rule 1: retry advice only where retrying can plausibly succeed.
    expect(
      userErrorCopy(sqliteError("database is locked", "SQLITE_BUSY"), ctx)
    ).toBe("Couldn't finish this backfill. Try again.");
    expect(
      userErrorCopy(new Error("fetch failed"), {
        doing: "sync",
        service: "Strava",
      })
    ).toBe("Couldn't reach Strava. Try again.");
    expect(userErrorCopy(new Error(OBSERVED_LEAK), ctx)).not.toContain(
      "Try again"
    );
  });

  it("an authored sentence passes through verbatim", () => {
    const authored =
      "Another provider already matches this identity. Merge the duplicates instead.";
    expect(userErrorCopy(new UserFacingError(authored), ctx)).toBe(authored);
  });

  it("an authored sentence is still redacted, and an empty one falls back", () => {
    // LOW-ENTROPY on purpose, and it costs the assertion NOTHING: `redactSecrets`
    // masks on the KEY, not on how random the value looks — measured 2026-08-23,
    // `token=fake` masks exactly as `token=<20 random chars>` does. So a
    // token-SHAPED literal would buy no extra coverage while tripping the repo's
    // secret scan, which reads every ref and would red every other open PR. Same
    // convention as backfill-error.test.ts's `token9word3`.
    expect(
      userErrorCopy(new UserFacingError("Reconnect: token=word7token3"), ctx)
    ).not.toContain("word7token3");
    expect(userErrorCopy(new UserFacingError("   "), ctx)).toBe(
      "Couldn't finish this backfill."
    );
  });

  it("no output carries machine vocabulary, for ANY of these inputs", () => {
    const inputs: unknown[] = [
      new Error(OBSERVED_LEAK),
      sqliteError("no such column: activity_telemetry.answer", "SQLITE_ERROR"),
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      Object.assign(new Error("boom"), {
        stack: "Error: boom\n    at run (lib/thing.ts:42:7)",
      }),
      undefined,
      null,
      { toString: () => "SQLITE_CONSTRAINT_UNIQUE: activity_segment_efforts" },
    ];
    for (const input of inputs) {
      const copy = userErrorCopy(input, ctx);
      for (const re of MACHINE_WORDS) {
        expect(copy, `${re} in ${copy}`).not.toMatch(re);
      }
    }
  });

  it("every sentence follows the house error shape (copy.md rules 1 and 3)", () => {
    const sentences = [
      userErrorCopy(new Error(OBSERVED_LEAK), ctx),
      userErrorCopy(new Error("fetch failed"), { ...ctx, service: "Strava" }),
      userErrorCopy(sqliteError("database is locked", "SQLITE_BUSY"), ctx),
      userErrorCopy("garbage", ctx),
    ];
    for (const s of sentences) {
      expect(s, s).toMatch(/^Couldn't /);
      expect(s, s).toMatch(/[.?!]$/);
      expect(s, s).not.toMatch(/\b(could not|failed to|unable to|please)\b/i);
    }
  });
});

describe("backfillErrorMessage is the chokepoint that stopped leaking", () => {
  it("the stuck job's SQLite string becomes house copy", () => {
    expect(backfillErrorMessage(new Error(OBSERVED_LEAK))).toBe(
      "Couldn't finish this backfill. It's a bug on our side."
    );
  });

  it("a silent error still gets the generic sentence, never a blank line", () => {
    expect(backfillErrorMessage(new Error(""))).toBe(
      "Couldn't finish this backfill."
    );
    expect(backfillErrorMessage(new UserFacingError(""))).toBe(
      "Couldn't finish this backfill."
    );
  });

  it("caps a runaway authored message rather than filling the card", () => {
    // capDetail appends a "(+N chars)" marker, so the result is the cap plus that.
    const long = backfillErrorMessage(new UserFacingError("x".repeat(5000)));
    expect(long.startsWith("x".repeat(300))).toBe(true);
    expect(long.length).toBeLessThan(340);
  });
});
