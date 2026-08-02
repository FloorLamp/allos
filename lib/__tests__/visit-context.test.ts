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
  typeKey: "office visit",
  ...o,
});

const prior = (o: Partial<PriorVisit> = {}): PriorVisit => ({
  date: "2026-03-02",
  providerId: 7,
  typeKey: "office visit",
  ...o,
});

describe("visitContext (#1350)", () => {
  it("gives no context for a genuine first visit", () => {
    const ctx = visitContext(sub(), []);
    expect(ctx.provider).toBeNull();
    expect(ctx.typeYear).toBeNull();
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

  it("counts matching visit types within the subject visit's year", () => {
    const ctx = visitContext(
      sub({ typeKey: "emergency visit", date: "2026-06-18" }),
      [
        prior({ typeKey: "emergency visit", date: "2026-01-20" }),
        prior({ typeKey: "emergency visit", date: "2025-12-30" }), // prior YEAR — ignored
        prior({ typeKey: "office visit", date: "2026-02-02" }), // different type — ignored
      ]
    );
    expect(ctx.typeYear).toEqual({ ordinal: 2 });
  });

  it("does not merge distinct visit types that share a coarse setting", () => {
    const ctx = visitContext(sub({ typeKey: "dental visit" }), [
      prior({ typeKey: "office visit" }),
    ]);
    expect(ctx.typeYear).toBeNull();
  });

  it("keeps the same-day predecessor in the ordinal but leaves priorDate null", () => {
    const ctx = visitContext(sub({ date: "2026-06-18" }), [
      prior({ date: "2026-06-18" }),
    ]);
    expect(ctx.provider?.ordinal).toBe(2);
    expect(ctx.provider?.priorDate).toBeNull();
  });
});
