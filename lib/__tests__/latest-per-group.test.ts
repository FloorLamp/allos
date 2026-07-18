import { describe, it, expect } from "vitest";
import { isLaterReading, latestByGroup } from "@/lib/latest-per-group";

describe("isLaterReading (the shared latest ordering rule, #944)", () => {
  it("a later date is later", () => {
    expect(isLaterReading({ date: "2026-02-01", id: 1 }, { date: "2026-01-01", id: 9 })).toBe(true);
    expect(isLaterReading({ date: "2026-01-01", id: 9 }, { date: "2026-02-01", id: 1 })).toBe(false);
  });
  it("on an equal date the higher id wins (mirrors SQL ORDER BY date DESC, id DESC)", () => {
    expect(isLaterReading({ date: "2026-01-01", id: 5 }, { date: "2026-01-01", id: 4 })).toBe(true);
    expect(isLaterReading({ date: "2026-01-01", id: 4 }, { date: "2026-01-01", id: 5 })).toBe(false);
  });
  it("a stored positive id beats a same-date derived negative id", () => {
    // Derived readings carry negative ids, so among same-date rows a stored reading
    // is preferred as latest — a property that falls straight out of the id tie-break.
    expect(isLaterReading({ date: "2026-01-01", id: 7 }, { date: "2026-01-01", id: -3 })).toBe(true);
  });
  it("an identical row is not strictly later than itself", () => {
    expect(isLaterReading({ date: "2026-01-01", id: 5 }, { date: "2026-01-01", id: 5 })).toBe(false);
  });
});

describe("latestByGroup (#944)", () => {
  it("keeps the newest row per group key", () => {
    const rows = [
      { id: 1, date: "2026-01-01", fam: "a" },
      { id: 2, date: "2026-03-01", fam: "a" },
      { id: 3, date: "2026-02-01", fam: "a" },
      { id: 4, date: "2026-05-01", fam: "b" },
    ];
    const best = latestByGroup(rows, (r) => r.fam);
    expect(best.get("a")?.id).toBe(2);
    expect(best.get("b")?.id).toBe(4);
    expect([...best.keys()].sort()).toEqual(["a", "b"]);
  });

  it("breaks a same-date tie on the higher id", () => {
    const rows = [
      { id: 10, date: "2026-01-01", fam: "a" },
      { id: 12, date: "2026-01-01", fam: "a" },
      { id: 11, date: "2026-01-01", fam: "a" },
    ];
    expect(latestByGroup(rows, (r) => r.fam).get("a")?.id).toBe(12);
  });

  it("groups collapse only by the supplied key, not the raw identity", () => {
    // Two different member names mapped to one family key share a single winner.
    const rows = [
      { id: 1, date: "2026-01-01", name: "Vitamin D, 25-OH", fam: "family:vitamin-d-25oh" },
      { id: 2, date: "2026-02-01", name: "Vitamin D", fam: "family:vitamin-d-25oh" },
    ];
    const best = latestByGroup(rows, (r) => r.fam);
    expect(best.size).toBe(1);
    expect(best.get("family:vitamin-d-25oh")?.id).toBe(2);
  });

  it("an empty input yields an empty map", () => {
    expect(latestByGroup([] as { id: number; date: string }[], () => "k").size).toBe(0);
  });
});
