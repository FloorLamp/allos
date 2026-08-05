import { beforeEach, describe, expect, it } from "vitest";
import {
  createStravaRequestBudget,
  resetStravaRateLimitState,
} from "@/lib/integrations/strava-rate-limit";

describe("Strava read-request budget", () => {
  beforeEach(resetStravaRateLimitState);

  it("keeps reserve below Strava's default read limits", () => {
    const budget = createStravaRequestBudget("client-a", 200);
    for (let request = 0; request < 95; request++) {
      expect(budget.reserve()).toBe(true);
    }
    expect(budget.reserve()).toBe(false);
    expect(budget.requests).toBe(95);
    expect(budget.exhausted).toBe(true);
  });

  it("shares observed application usage across profiles with one client id", () => {
    const firstProfile = createStravaRequestBudget("shared-client", 200);
    expect(firstProfile.reserve()).toBe(true);
    firstProfile.observe(
      new Headers({
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "94,400",
      })
    );

    const secondProfile = createStravaRequestBudget("shared-client", 200);
    expect(secondProfile.reserve()).toBe(true);
    expect(secondProfile.reserve()).toBe(false);
    expect(createStravaRequestBudget("other-client", 1).reserve()).toBe(true);
  });

  it("uses upgraded header limits and resets at natural provider windows", () => {
    let at = Date.parse("2026-08-05T12:01:00Z");
    const budget = createStravaRequestBudget("upgraded-client", 300, () => at);
    expect(budget.reserve()).toBe(true);
    budget.observe(
      new Headers({
        "X-ReadRateLimit-Limit": "200,2000",
        "X-ReadRateLimit-Usage": "195,500",
      })
    );
    expect(budget.reserve()).toBe(false);

    at = Date.parse("2026-08-05T12:16:00Z");
    const nextWindow = createStravaRequestBudget(
      "upgraded-client",
      300,
      () => at
    );
    expect(nextWindow.reserve()).toBe(true);
  });

  it("waits for the UTC day reset after a daily-quota 429", () => {
    const at = Date.parse("2026-08-05T12:01:00Z");
    const budget = createStravaRequestBudget("daily-client", 300, () => at);
    expect(budget.reserve()).toBe(true);
    budget.observe(
      new Headers({
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "10,1000",
      })
    );

    budget.markRateLimited();

    expect(budget.exhausted).toBe(true);
    expect(budget.retryAfterAt).toBe("2026-08-06T00:00:00.000Z");
  });
});
