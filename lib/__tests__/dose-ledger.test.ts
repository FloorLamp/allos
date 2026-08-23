import { describe, it, expect } from "vitest";
import {
  DOSE_LEDGER_KIND_FILTERS,
  DOSE_LEDGER_KIND_LABELS,
  defaultDoseLedgerRange,
  doseLedgerEmptyNote,
  doseLedgerQueryKind,
  doseLedgerWindowNote,
  resolveDoseLedgerKind,
  resolveDoseLedgerRange,
} from "@/lib/dose-ledger";
import { DOSE_HISTORY_DAYS } from "@/lib/intake-adherence";
import { MACHINE_DATE_RE } from "@/lib/machine-date-census";
import { DEFAULT_FORMAT_PREFS } from "@/lib/format-date";
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

  // The census's own rule, not a second spelling of it: a note that regresses to
  // storage format has to fail HERE, in a tier that runs in milliseconds, as well as
  // on the rendered page (e2e/machine-date-census.spec.ts).
  const machineDates = (text: string) => [...text.matchAll(MACHINE_DATE_RE)];

  it("states the bound it is showing, and states none when there is none", () => {
    expect(
      doseLedgerWindowNote({}, DEFAULT_FORMAT_PREFS, today)
    ).toBeUndefined();
    expect(
      doseLedgerWindowNote(
        { from: "2026-07-01", to: "2026-07-31" },
        DEFAULT_FORMAT_PREFS,
        today
      )
    ).toBe(
      "Showing confirmed doses from Jul 1 to Jul 31. Older doses are still on record."
    );
    expect(
      doseLedgerWindowNote({ from: "2026-07-01" }, DEFAULT_FORMAT_PREFS, today)
    ).toContain("onward");
    expect(
      doseLedgerWindowNote({ to: "2026-07-31" }, DEFAULT_FORMAT_PREFS, today)
    ).toBe("Showing confirmed doses up to Jul 31.");
  });

  it("renders its bounds in the DISPLAY format, never storage format (#3478 item 2)", () => {
    // Every shape of the window, in every date pref, against the census's matcher.
    // "iso" is the pref a reader ASKED for machine shape in, so it is the one case
    // the rule cannot speak to — it is excluded here for that reason and not by
    // accident.
    const ranges = [
      { from: "2026-07-01", to: "2026-07-31" },
      { from: "2026-07-01" },
      { to: "2026-07-31" },
      // A window that crosses the year boundary, so the auto-year rule fires.
      { from: "2025-12-24", to: "2026-01-06" },
    ];
    for (const dateFormat of ["mdy", "dmy"] as const) {
      for (const range of ranges) {
        const note = doseLedgerWindowNote(
          range,
          { ...DEFAULT_FORMAT_PREFS, dateFormat },
          today
        );
        expect(note, `${dateFormat} ${JSON.stringify(range)}`).toBeDefined();
        expect(machineDates(note ?? ""), note).toEqual([]);
      }
    }
  });

  it("asks the auto-year question in the PROFILE's today, not the process clock", () => {
    // Same date, two reference days: inside the reference year the year is dropped,
    // outside it the year is kept. Nothing here reads the wall clock.
    expect(
      doseLedgerWindowNote(
        { from: "2026-01-05", to: "2026-01-06" },
        DEFAULT_FORMAT_PREFS,
        "2026-08-10"
      )
    ).toContain("Jan 5 to Jan 6");
    expect(
      doseLedgerWindowNote(
        { from: "2026-01-05", to: "2026-01-06" },
        DEFAULT_FORMAT_PREFS,
        "2027-02-01"
      )
    ).toContain("Jan 5, 2026 to Jan 6, 2026");
  });
});

describe("the dose ledger's empty state (#3478 item 3)", () => {
  const today = "2026-08-10";
  const window = { from: "2026-05-13", to: "2026-08-10" };

  it("leads with the state, folds the window into it, and names the filtered kind", () => {
    expect(
      doseLedgerEmptyNote(window, "medication", DEFAULT_FORMAT_PREFS, today)
    ).toBe(
      "No medication doses confirmed between May 13 and Aug 10. Widen the date range, or confirm a dose on Medications."
    );
    expect(
      doseLedgerEmptyNote(window, "supplement", DEFAULT_FORMAT_PREFS, today)
    ).toBe(
      "No supplement doses confirmed between May 13 and Aug 10. Widen the date range, or confirm a dose on Supplements."
    );
    // Only the WIDENED filter may name both surfaces — a ledger pre-filtered to one
    // kind pointing at the other is the kind-blind copy this replaced.
    expect(
      doseLedgerEmptyNote(window, "all", DEFAULT_FORMAT_PREFS, today)
    ).toBe(
      "No doses confirmed between May 13 and Aug 10. Widen the date range, or confirm a dose on Supplements or Medications."
    );
  });

  it("never offers to widen a window that has no bound", () => {
    const allTime = doseLedgerEmptyNote(
      {},
      "medication",
      DEFAULT_FORMAT_PREFS,
      today
    );
    expect(allTime).toBe(
      "No medication doses confirmed yet. Confirm a dose on Medications."
    );
    expect(allTime).not.toContain("Widen");
  });

  it("states a half-open window on the side it actually has", () => {
    expect(
      doseLedgerEmptyNote(
        { from: "2026-07-01" },
        "all",
        DEFAULT_FORMAT_PREFS,
        today
      )
    ).toContain("since Jul 1");
    expect(
      doseLedgerEmptyNote(
        { to: "2026-07-31" },
        "all",
        DEFAULT_FORMAT_PREFS,
        today
      )
    ).toContain("up to Jul 31");
  });

  it("renders its bounds in the DISPLAY format, in every kind and every window", () => {
    for (const kind of DOSE_LEDGER_KIND_FILTERS) {
      for (const range of [
        window,
        { from: "2026-07-01" },
        { to: "2026-07-31" },
        {},
      ]) {
        const note = doseLedgerEmptyNote(
          range,
          kind,
          DEFAULT_FORMAT_PREFS,
          today
        );
        expect(
          [...note.matchAll(MACHINE_DATE_RE)],
          `${kind} ${JSON.stringify(range)}: ${note}`
        ).toEqual([]);
      }
    }
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
