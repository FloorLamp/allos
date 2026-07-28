import { describe, expect, it } from "vitest";
import {
  PROTOCOL_REOPEN_WINDOW_DAYS,
  protocolReopenEligibility,
} from "@/lib/protocol-reopen";

describe("protocolReopenEligibility", () => {
  it("treats protocol end_date as inclusive and allows resume through day seven", () => {
    expect(protocolReopenEligibility("2026-07-18", "2026-07-18")).toEqual({
      kind: "eligible",
      elapsedDays: 0,
    });
    expect(protocolReopenEligibility("2026-07-18", "2026-07-25")).toEqual({
      kind: "eligible",
      elapsedDays: PROTOCOL_REOPEN_WINDOW_DAYS,
    });
  });

  it("requires a new run after the seven-day boundary", () => {
    expect(protocolReopenEligibility("2026-07-18", "2026-07-26")).toEqual({
      kind: "expired",
    });
  });

  it("rejects ongoing, malformed, and future-ended ranges", () => {
    expect(protocolReopenEligibility(null, "2026-07-18")).toEqual({
      kind: "ongoing",
    });
    expect(protocolReopenEligibility("not-a-date", "2026-07-18")).toEqual({
      kind: "invalid",
    });
    expect(protocolReopenEligibility("2026-07-19", "2026-07-18")).toEqual({
      kind: "invalid",
    });
  });
});
