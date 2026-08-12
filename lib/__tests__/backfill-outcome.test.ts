import { describe, expect, it } from "vitest";
import { backfillFetchVerdict } from "@/lib/integrations/backfill-outcome";

describe("backfill item verdict (#2196)", () => {
  it("calls a refusal, a deletion and a tombstone final", () => {
    expect(backfillFetchVerdict(403)).toBe("unavailable");
    expect(backfillFetchVerdict(404)).toBe("unavailable");
    expect(backfillFetchVerdict(410)).toBe("unavailable");
  });

  it("keeps every not-right-now failure retryable", () => {
    // 0 is stravaGet's marker for a network throw or timeout (no HTTP response).
    expect(backfillFetchVerdict(0)).toBe("retryable");
    expect(backfillFetchVerdict(401)).toBe("retryable");
    expect(backfillFetchVerdict(500)).toBe("retryable");
    expect(backfillFetchVerdict(502)).toBe("retryable");
    expect(backfillFetchVerdict(503)).toBe("retryable");
  });

  it("does not swallow a rate limit, which the caller pauses on first", () => {
    // The runner checks isPullRateLimited BEFORE asking for a verdict. Answering
    // "retryable" here means a caller that forgot the check would keep the row rather
    // than silently abandoning a whole quota window's worth of candidates.
    expect(backfillFetchVerdict(429)).toBe("retryable");
  });

  it("leaves a malformed request loud rather than quietly final", () => {
    // A 400 is our own bug; the fix is a deploy, after which the retry works. The
    // conservative direction is the visible one — the job stays `failed` and says so.
    expect(backfillFetchVerdict(400)).toBe("retryable");
  });
});
