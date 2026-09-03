import { describe, it, expect } from "vitest";
import {
  CLINICAL_RESULT_FRESH_DAYS,
  clinicalResultClaimsFreshness,
  clinicalResultHostsAcknowledge,
  recentLabHighlights,
  RECENT_LAB_STALE_DAYS,
} from "@/lib/recent-labs";
import { shiftDateStr } from "@/lib/date";
import type { ClinicalObservation } from "@/lib/types";

// The dashboard's recent-labs highlight selection (issue #313): of the current
// lab readings, out-of-range floats to the top, then newest-first, then
// take the first `limit`, flattened to display rows.

type LabInput = Parameters<typeof recentLabHighlights>[0][number];

function rec(over: Partial<ClinicalObservation> = {}): LabInput {
  return {
    category: "lab",
    flag: "normal",
    date: "2026-01-01",
    canonical_name: null,
    name: "Glucose",
    value: "90",
    unit: "mg/dL",
    ...over,
  };
}

describe("recentLabHighlights", () => {
  it("keeps only lab category (#1076)", () => {
    const rows = recentLabHighlights([
      rec({ category: "lab", name: "A" }),
      // Vitals, screening instruments, derived bio-age, immutable facts, and the
      // Pending classification and dedicated categories are NOT recent labs.
      rec({ category: null, name: "B" }),
      rec({ category: "vitals", name: "C" }),
      rec({ category: "scan", name: "D" }),
      rec({ category: "prescription", name: "E" }),
      rec({ category: "instrument", name: "F" }),
      rec({ category: "derived", name: "G" }),
      rec({ category: "reference", name: "H" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["A"]);
  });

  it("floats out-of-range (non-normal, non-null) flags to the top", () => {
    const rows = recentLabHighlights([
      rec({ name: "Normal", flag: "normal", date: "2026-05-01" }),
      rec({ name: "High", flag: "high", date: "2026-01-01" }),
    ]);
    // High is older but flagged, so it leads.
    expect(rows.map((r) => r.name)).toEqual(["High", "Normal"]);
  });

  it("treats a null flag as not-flagged (ranks below a flagged row)", () => {
    const rows = recentLabHighlights([
      rec({ name: "Unflagged", flag: null, date: "2026-05-01" }),
      rec({ name: "Low", flag: "low", date: "2026-01-01" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Low", "Unflagged"]);
  });

  it("breaks ties within the same flag class newest-first", () => {
    const rows = recentLabHighlights([
      rec({ name: "Older", flag: "normal", date: "2026-01-01" }),
      rec({ name: "Newer", flag: "normal", date: "2026-06-01" }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Newer", "Older"]);
  });

  it("limits to 6 by default and honors an explicit limit", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      rec({ name: `M${i}`, date: `2026-01-${String(i + 1).padStart(2, "0")}` })
    );
    expect(recentLabHighlights(many)).toHaveLength(6);
    expect(recentLabHighlights(many, 3)).toHaveLength(3);
  });

  it("uses a trimmed canonical_name over name, with a biomarker deep-link", () => {
    const [row] = recentLabHighlights([
      rec({ name: "raw name", canonical_name: "  LDL Cholesterol  " }),
    ]);
    expect(row.name).toBe("LDL Cholesterol");
    expect(row.href).toBe(
      "/results/clinical-results/view?name=LDL%20Cholesterol"
    );
  });

  it("links to the Clinical results index when there is no canonical name", () => {
    const [row] = recentLabHighlights([
      rec({ name: "Glucose", canonical_name: null }),
    ]);
    expect(row.name).toBe("Glucose");
    expect(row.href).toBe("/results/clinical-results");
  });

  it("does not mutate the input array order", () => {
    const input = [
      rec({ name: "A", flag: "normal", date: "2026-01-01" }),
      rec({ name: "B", flag: "high", date: "2026-02-01" }),
    ];
    recentLabHighlights(input);
    expect(input.map((r) => r.name)).toEqual(["A", "B"]);
  });

  // #1216: the recency floor, resolved since #2303 by the shared `freshnessState`.
  // Without a `todayStr` no age can be computed, so the row is `not-applicable` — no
  // claim either way, where the retired boolean read as fresh. With one, a reading past
  // the year window is `due` (still surfaced — an unresolved abnormal never expires —
  // but labeled).
  it("claims nothing about an undatable row (no todayStr)", () => {
    const rows = recentLabHighlights([
      rec({ name: "Old", date: "2010-01-01" }),
    ]);
    expect(rows[0].freshness).toBe("not-applicable");
  });

  it("marks a reading older than the year floor due", () => {
    const today = "2026-07-15";
    const rows = recentLabHighlights(
      [
        rec({ name: "Fresh", date: "2026-07-01" }),
        rec({ name: "Aged", date: "2024-01-01" }),
      ],
      6,
      today
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.freshness]));
    expect(byName["Fresh"]).toBe("current");
    expect(byName["Aged"]).toBe("due");
  });

  // The migration onto the shared decision must not move the boundary: stale STRICTLY
  // after the floor, so a reading exactly a year old is still current.
  it("keeps the floor boundary — exactly at the floor is current, one day past is due", () => {
    const today = "2026-07-15";
    const at = shiftDateStr(today, -RECENT_LAB_STALE_DAYS);
    const past = shiftDateStr(today, -(RECENT_LAB_STALE_DAYS + 1));
    const rows = recentLabHighlights(
      [rec({ name: "At", date: at }), rec({ name: "Past", date: past })],
      6,
      today
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.freshness]));
    expect(byName["At"]).toBe("current");
    expect(byName["Past"]).toBe("due");
  });

  it("keeps a stale flagged marker in the list, labeled not hidden", () => {
    const today = "2026-07-15";
    const rows = recentLabHighlights(
      [rec({ name: "OldAbnormal", flag: "abnormal", date: "2022-01-01" })],
      6,
      today
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].freshness).toBe("due");
  });
});

// ---- Acknowledged notables lose their ordering precedence (#3225) -----------
//
// Owner ruling 2026-08-19: "acknowledge, not summary-row or rotation — a per-marker
// 'seen' that stops a chronic notable from outranking, with newest-first among the
// unacknowledged." The owner's data is 37 notable markers essentially all from ONE
// panel, so notable-first alone seats the same six rows for months and the Standing
// family never changes. Acknowledgment spends the claim; the flag itself does not
// move, which is what keeps this an ORDER change and not a suppression.
describe("recentLabHighlights acknowledgment order (#3225)", () => {
  // Seven notables from one draw, then two ordinary results from a later one — the
  // shape the issue names ("fixture with >cap notables from one draw"). Unfixed, the
  // six seats are N1–N6 no matter what anyone acknowledges.
  const DRAW = "2026-06-03";
  const LATER = "2026-08-20";
  const rows = [
    ...["N1", "N2", "N3", "N4", "N5", "N6", "N7"].map((name) =>
      rec({ name, flag: "high", date: DRAW })
    ),
    ...["R1", "R2"].map((name) => rec({ name, flag: "normal", date: LATER })),
  ];
  const seat = (acked: readonly string[]) =>
    recentLabHighlights(rows, 6, undefined, (name) => acked.includes(name)).map(
      (r) => r.name
    );

  it.each([
    {
      case: "none acknowledged — the pinned six, unchanged",
      acked: [],
      seated: ["N1", "N2", "N3", "N4", "N5", "N6"],
    },
    {
      case: "three acknowledged — the seats move to what has not been seen",
      acked: ["N1", "N2", "N3"],
      seated: ["N4", "N5", "N6", "N7", "R1", "R2"],
    },
    {
      case: "all acknowledged — newest results, never an empty box",
      acked: ["N1", "N2", "N3", "N4", "N5", "N6", "N7"],
      seated: ["R1", "R2", "N1", "N2", "N3", "N4"],
    },
  ])("$case", ({ acked, seated }) => {
    expect(seat(acked)).toEqual(seated);
  });

  it("moves precedence only — the acknowledged row keeps its flag and its place in the list", () => {
    const out = recentLabHighlights(rows, 9, undefined, (n) => n === "N1");
    const n1 = out.find((r) => r.name === "N1");
    // Still present, still high: /results and every notability read are untouched.
    expect(n1?.flag).toBe("high");
    // …and it now sorts by date among the ordinary results rather than ahead of them.
    expect(out.map((r) => r.name).indexOf("N1")).toBeGreaterThan(
      out.map((r) => r.name).indexOf("R1")
    );
  });

  it("no predicate is the pre-#3225 order, byte for byte — the digest and recap are out of scope", () => {
    expect(recentLabHighlights(rows, 6).map((r) => r.name)).toEqual(seat([]));
  });
});

// FRESH RESULTS ARE RELEVANT (owner ruling #4232, 2026-08-30). The claim ends at
// whichever comes first: the acknowledgment, or the window measured from the
// COLLECTION date. Keying on collection is what makes a backfilled import of old
// records claim nothing, and it is the half the boundary table below exists to pin —
// the row a plain "is it recent" check would get wrong is the one that landed today
// and was drawn years ago.
describe("clinicalResultClaimsFreshness (#4232)", () => {
  const today = "2026-08-31";
  const daysAgo = (n: number) => shiftDateStr(today, -n);

  it.each([
    { case: "collected today", collected: today, acked: false, claims: true },
    {
      case: "collected inside the window",
      collected: daysAgo(CLINICAL_RESULT_FRESH_DAYS - 1),
      acked: false,
      claims: true,
    },
    {
      case: "collected exactly one window ago (the boundary is inclusive)",
      collected: daysAgo(CLINICAL_RESULT_FRESH_DAYS),
      acked: false,
      claims: true,
    },
    {
      case: "collected one day past the window",
      collected: daysAgo(CLINICAL_RESULT_FRESH_DAYS + 1),
      acked: false,
      claims: false,
    },
    {
      case: "a backfilled import of an old draw",
      collected: "2019-03-04",
      acked: false,
      claims: false,
    },
    {
      case: "acknowledged inside the window",
      collected: today,
      acked: true,
      claims: false,
    },
    {
      case: "an undatable reading claims nothing either way",
      collected: null,
      acked: false,
      claims: false,
    },
  ])("$case", ({ collected, acked, claims }) => {
    expect(clinicalResultClaimsFreshness(collected, today, acked)).toBe(claims);
  });

  // The window is a RULED threshold (#3934 declined to guess it so the owner could
  // set it), so it is pinned rather than merely used — a silent widening would make
  // every row above pass while the page claimed for a different length of time.
  it("keys the window on the ruled 30 days", () => {
    expect(CLINICAL_RESULT_FRESH_DAYS).toBe(30);
  });
});

// WHICH ROWS HOST THEIR OWN ACKNOWLEDGE CONTROL (#3225, generalising #4232).
//
// The population this issue is about is the CHRONIC NOTABLE: 37 markers from one
// June panel, notable, long past the 30-day freshness window AND past the 14-day
// collection window that bounds a flagged-result attention item — so under #4232's
// freshness-only rule no row on the dashboard offered the acknowledgment that spends
// its precedence. The first row of the table is that case and it is the one that
// moved; every other row is a side of the boundary that must NOT have moved.
describe("clinicalResultHostsAcknowledge (#3225)", () => {
  const today = "2026-09-03";
  const CHRONIC = "2026-06-03"; // the owner's panel: notable, 92 days old
  const daysAgo = (n: number) => shiftDateStr(today, -n);

  it.each([
    {
      case: "a chronic notable with no attention item — the case that had no control",
      collectedOn: CHRONIC,
      flag: "high" as const,
      acknowledged: false,
      hasAttentionItem: false,
      hosts: true,
    },
    {
      case: "…and once acknowledged it stops offering the same state twice",
      collectedOn: CHRONIC,
      flag: "high" as const,
      acknowledged: true,
      hasAttentionItem: false,
      hosts: false,
    },
    {
      case: "a notable still inside the attention window hosts the menu there",
      collectedOn: daysAgo(3),
      flag: "high" as const,
      acknowledged: false,
      hasAttentionItem: true,
      hosts: false,
    },
    {
      case: "a fresh non-notable result — #4232's own case, unchanged",
      collectedOn: daysAgo(3),
      flag: "normal" as const,
      acknowledged: false,
      hasAttentionItem: false,
      hosts: true,
    },
    {
      case: "an old ordinary result has no claim to spend",
      collectedOn: CHRONIC,
      flag: "normal" as const,
      acknowledged: false,
      hasAttentionItem: false,
      hosts: false,
    },
    {
      case: "a good durable-immunity titer is not notable (#544)",
      collectedOn: CHRONIC,
      flag: "immune" as const,
      acknowledged: false,
      hasAttentionItem: false,
      hosts: false,
    },
    {
      case: "an undatable notable still hosts one — notability needs no date",
      collectedOn: null,
      flag: "low" as const,
      acknowledged: false,
      hasAttentionItem: false,
      hosts: true,
    },
  ])(
    "$case",
    ({ collectedOn, flag, acknowledged, hasAttentionItem, hosts }) => {
      expect(
        clinicalResultHostsAcknowledge({
          collectedOn,
          today,
          flag,
          acknowledged,
          hasAttentionItem,
        })
      ).toBe(hosts);
    }
  );
});
