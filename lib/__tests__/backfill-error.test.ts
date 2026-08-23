import { describe, it, expect } from "vitest";
import {
  backfillErrorMessage,
  MAX_BACKFILL_ERROR_CHARS,
} from "@/lib/integrations/backfill-error";
import { UserFacingError } from "@/lib/user-error-copy";

// #2820 asked the SECURITY question of `integration_backfill_jobs.error`: the column
// is rendered onto the owning profile's page, so a caught runner error must not carry
// a token there. #3198 asks the COMPREHENSIBILITY one, and answers it in a way that
// subsumes the first — the classifier never returns raw text, so a credential the
// redactor might have missed cannot reach the column either.
//
// The four attack strings below are #2820's own, kept verbatim. They are the receipt
// that the guarantee got STRONGER rather than being traded away: each one used to be
// persisted redacted, and each one is now not persisted at all.
const SECRET_BEARING = [
  "strava refused header Bearer token9word3",
  "GET https://example.test/v2/measure?userid=41&access_token=word7digit3 failed with 401",
  'withings said {"client_secret":"seven7seven","status":401}',
  "token=abc4",
];

describe("backfillErrorMessage: what a caught backfill error may persist", () => {
  it("persists no fragment of a secret-bearing upstream message", () => {
    for (const raw of SECRET_BEARING) {
      const out = backfillErrorMessage(new Error(raw));
      for (const leaked of [
        "token9word3",
        "word7digit3",
        "seven7seven",
        "abc4",
        "Bearer",
        "access_token",
        "client_secret",
      ]) {
        expect(out, `${leaked} survived from: ${raw}`).not.toContain(leaked);
      }
    }
  });

  it("persists house copy instead of the message, whatever was thrown", () => {
    expect(backfillErrorMessage(new Error("fetch failed"))).toBe(
      "Couldn't finish this backfill. Try again."
    );
    expect(backfillErrorMessage("plain string blew up")).toBe(
      "Couldn't finish this backfill."
    );
    expect(backfillErrorMessage({ toString: () => "token=abc4" })).toBe(
      "Couldn't finish this backfill."
    );
    expect(backfillErrorMessage(new Error(""))).toBe(
      "Couldn't finish this backfill."
    );
  });

  it("bounds a runaway AUTHORED message so the card cannot become a wall of text", () => {
    // House copy is short by construction; the authored family passes a thrower's
    // own sentence through, and that has no length rule of its own — which is the
    // one way this column can still grow.
    const out = backfillErrorMessage(new UserFacingError("x".repeat(5000)));
    expect(out.startsWith("x".repeat(MAX_BACKFILL_ERROR_CHARS))).toBe(true);
    expect(out.length).toBeLessThan(MAX_BACKFILL_ERROR_CHARS + 40);
    expect(out).toContain("+4700 chars");
  });
});
