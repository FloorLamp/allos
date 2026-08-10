import { describe, it, expect } from "vitest";
import {
  DOSE_LEDGER_KIND_FILTERS,
  DOSE_LEDGER_KIND_LABELS,
  defaultDoseLedgerRange,
  doseLedgerQueryKind,
  doseLedgerWindowNote,
  resolveDoseLedgerKind,
  resolveDoseLedgerRange,
} from "@/lib/dose-ledger";
import { DOSE_HISTORY_DAYS } from "@/lib/supplement-adherence";
import { doseLedgerHref } from "@/lib/hrefs";

describe("the dose ledger's kind filter", () => {
  it("opens pre-filtered to the surface's own kind when the URL names nothing", () => {
    expect(resolveDoseLedgerKind(undefined, "supplement")).toBe("supplement");
    expect(resolveDoseLedgerKind(undefined, "medication")).toBe("medication");
    // An unrecognised value is not a third state — it falls back to the surface.
    expect(resolveDoseLedgerKind("vitamins", "medication")).toBe("medication");
  });

  it("lets an explicit value widen or switch", () => {
    expect(resolveDoseLedgerKind("all", "supplement")).toBe("all");
    expect(resolveDoseLedgerKind("medication", "supplement")).toBe(
      "medication"
    );
  });

  it("asks the reader for no kind narrowing at all when widened", () => {
    expect(doseLedgerQueryKind("all")).toBeUndefined();
    expect(doseLedgerQueryKind("supplement")).toBe("supplement");
    expect(doseLedgerQueryKind("medication")).toBe("medication");
  });

  it("labels every declared filter state", () => {
    for (const filter of DOSE_LEDGER_KIND_FILTERS) {
      expect(DOSE_LEDGER_KIND_LABELS[filter]).toBeTruthy();
    }
  });
});

describe("the dose ledger's window", () => {
  const today = "2026-08-10";

  it("defaults to the same DOSE_HISTORY_DAYS span the per-item panels bound to", () => {
    const range = defaultDoseLedgerRange(today);
    expect(range.to).toBe(today);
    // Inclusive of both ends: 90 days ending today starts 89 days back.
    expect(range.from).toBe("2026-05-13");
    expect(DOSE_HISTORY_DAYS).toBe(90);
  });

  it("uses an explicit window verbatim, including a single-day drill-in", () => {
    expect(
      resolveDoseLedgerRange({ from: "2026-07-01", to: "2026-07-01" }, today)
    ).toEqual({ from: "2026-07-01", to: "2026-07-01" });
    // A half-open window keeps its open side open.
    expect(resolveDoseLedgerRange({ from: "2026-07-01" }, today)).toEqual({
      from: "2026-07-01",
    });
  });

  it("treats the range sentinel as a real all-time answer, not as 'no params'", () => {
    expect(resolveDoseLedgerRange({}, today, "all")).toEqual({});
    expect(resolveDoseLedgerRange({}, today)).toEqual(
      defaultDoseLedgerRange(today)
    );
  });

  it("states the bound it is showing, and states none when there is none", () => {
    expect(doseLedgerWindowNote({})).toBeUndefined();
    expect(
      doseLedgerWindowNote({ from: "2026-07-01", to: "2026-07-31" })
    ).toContain("2026-07-01");
    expect(doseLedgerWindowNote({ from: "2026-07-01" })).toContain("onward");
  });
});

describe("doseLedgerHref", () => {
  it("routes each surface to its own door", () => {
    expect(doseLedgerHref("supplement")).toBe("/nutrition/dose-history");
    expect(doseLedgerHref("medication")).toBe("/medications/dose-history");
  });

  it("carries the filter state a shared link has to reproduce", () => {
    expect(
      doseLedgerHref("supplement", {
        from: "2026-07-01",
        to: "2026-07-01",
        kind: "all",
      })
    ).toBe("/nutrition/dose-history?from=2026-07-01&to=2026-07-01&kind=all");
    expect(doseLedgerHref("medication", { item: 7 })).toBe(
      "/medications/dose-history?item=7"
    );
  });

  it("says all-time explicitly, because an empty query string means the default window", () => {
    expect(doseLedgerHref("supplement", { allTime: true })).toBe(
      "/nutrition/dose-history?range=all"
    );
  });
});
