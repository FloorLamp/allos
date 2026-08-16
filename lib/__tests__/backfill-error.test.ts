import { describe, it, expect } from "vitest";
import {
  backfillErrorMessage,
  MAX_BACKFILL_ERROR_CHARS,
} from "@/lib/integrations/backfill-error";

// #2820 — `integration_backfill_jobs.error` is rendered verbatim onto the owning
// profile's page, so what a caught runner error is allowed to put there is a security
// question, not a formatting one.
describe("backfillErrorMessage: what a caught backfill error may persist", () => {
  it("masks a bearer token an upstream client echoed into its message", () => {
    const out = backfillErrorMessage(
      new Error("strava refused header Bearer token9word3")
    );
    expect(out).toBe("strava refused header Bearer ***");
    expect(out).not.toContain("token9word3");
  });

  it("masks a token carried in the failing request's query string", () => {
    const out = backfillErrorMessage(
      new Error(
        "GET https://example.test/v2/measure?userid=41&access_token=word7digit3 failed with 401"
      )
    );
    expect(out).toContain("access_token=***");
    expect(out).not.toContain("word7digit3");
    // The rest of the message survives — an operator reading the row still learns
    // which call failed and how.
    expect(out).toContain("userid=41");
    expect(out).toContain("401");
  });

  it("masks a secret echoed from a response body", () => {
    const out = backfillErrorMessage(
      new Error('withings said {"client_secret":"seven7seven","status":401}')
    );
    expect(out).toContain('"client_secret":"***"');
    expect(out).not.toContain("seven7seven");
  });

  it("keeps an ordinary message unchanged", () => {
    expect(backfillErrorMessage(new Error("fetch failed"))).toBe(
      "fetch failed"
    );
  });

  it("accepts a non-Error throw the same way", () => {
    expect(backfillErrorMessage("plain string blew up")).toBe(
      "plain string blew up"
    );
    expect(backfillErrorMessage({ toString: () => "token=abc4" })).toBe(
      "token=***"
    );
  });

  it("bounds a runaway upstream message so the card cannot become a wall of text", () => {
    const out = backfillErrorMessage(new Error("x".repeat(5000)));
    expect(out).not.toBeNull();
    // capDetail appends a "(+N chars)" marker, so the result is the cap plus that.
    expect(out!.startsWith("x".repeat(MAX_BACKFILL_ERROR_CHARS))).toBe(true);
    expect(out!.length).toBeLessThan(MAX_BACKFILL_ERROR_CHARS + 40);
    expect(out).toContain("+4700 chars");
  });

  it("returns null when the error says nothing, so the card's own sentence renders", () => {
    // A blank stored string would NOT hit the component's `job.error ?? …` fallback and
    // would paint an empty red line; null does hit it.
    expect(backfillErrorMessage(new Error(""))).toBeNull();
    expect(backfillErrorMessage(new Error("   \n "))).toBeNull();
  });
});
