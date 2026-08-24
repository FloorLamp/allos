import { describe, expect, it } from "vitest";
import {
  EVENT_LEDGER_DEFAULT_DAYS,
  resolveEventLedgerRange,
} from "@/lib/event-ledger";

describe("event ledger range", () => {
  it("keeps explicit bounds and gives a bare mount one shared bounded default", () => {
    expect(
      resolveEventLedgerRange(
        { from: "2026-07-01", to: "2026-07-02" },
        "2026-08-24"
      )
    ).toEqual({
      from: "2026-07-01",
      to: "2026-07-02",
    });
    expect(EVENT_LEDGER_DEFAULT_DAYS).toBe(90);
    expect(resolveEventLedgerRange({}, "2026-08-24")).toEqual({
      from: "2026-05-27",
      to: "2026-08-24",
    });
    expect(resolveEventLedgerRange({}, "2026-08-24", "all")).toEqual({});
  });
});
