import { describe, it, expect } from "vitest";
import {
  visitContext,
  type PriorVisit,
  type VisitContextSubject,
} from "@/lib/visit-context";

const sub = (o: Partial<VisitContextSubject> = {}): VisitContextSubject => ({
  date: "2026-06-18",
  providerId: 7,
  providerName: "Dr. Patel",
  kind: "ambulatory",
  ...o,
});

const prior = (o: Partial<PriorVisit> = {}): PriorVisit => ({
  date: "2026-03-02",
  providerId: 7,
  kind: "ambulatory",
  ...o,
});

describe("visitContext (#1350)", () => {
  it("gives no context for a genuine first visit", () => {
    const ctx = visitContext(sub(), []);
    expect(ctx.provider).toBeNull();
    expect(ctx.kindYear).toBeNull();
  });

  it("counts the same-provider series and names the last prior visit", () => {
    const ctx = visitContext(sub(), [
      prior({ date: "2026-03-02" }),
      prior({ date: "2025-11-10" }),
      prior({ date: "2026-01-05", providerId: 99 }), // different provider — ignored
    ]);
    expect(ctx.provider).toEqual({
      name: "Dr. Patel",
      ordinal: 3,
      priorDate: "2026-03-02",
    });
  });

  it("ignores same-provider visits AFTER the subject visit", () => {
    const ctx = visitContext(sub({ date: "2026-06-18" }), [
      prior({ date: "2026-03-02" }),
      prior({ date: "2026-09-01" }), // later — not a predecessor
    ]);
    expect(ctx.provider?.ordinal).toBe(2);
    expect(ctx.provider?.priorDate).toBe("2026-03-02");
  });

  it("orders across input order and picks the latest earlier date", () => {
    const ctx = visitContext(sub(), [
      prior({ date: "2025-06-01" }),
      prior({ date: "2026-05-30" }),
      prior({ date: "2026-02-14" }),
    ]);
    expect(ctx.provider?.ordinal).toBe(4);
    expect(ctx.provider?.priorDate).toBe("2026-05-30");
  });

  it("gives no provider context when the provider is unnamed or unlinked", () => {
    expect(
      visitContext(sub({ providerId: null }), [prior()]).provider
    ).toBeNull();
    expect(
      visitContext(sub({ providerName: null }), [prior()]).provider
    ).toBeNull();
  });

  it("counts same-kind visits within the subject visit's year", () => {
    const ctx = visitContext(sub({ kind: "emergency", date: "2026-06-18" }), [
      prior({ kind: "emergency", date: "2026-01-20" }),
      prior({ kind: "emergency", date: "2025-12-30" }), // prior YEAR — ignored
      prior({ kind: "ambulatory", date: "2026-02-02" }), // different kind — ignored
    ]);
    expect(ctx.kindYear).toEqual({ ordinal: 2 });
  });

  it("keeps the same-day predecessor in the ordinal but leaves priorDate null", () => {
    const ctx = visitContext(sub({ date: "2026-06-18" }), [
      prior({ date: "2026-06-18" }),
    ]);
    expect(ctx.provider?.ordinal).toBe(2);
    expect(ctx.provider?.priorDate).toBeNull();
  });
});
