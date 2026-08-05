import { describe, it, expect } from "vitest";
import {
  buildUpcomingDigest,
  digestHighlights,
  summarizeBand,
} from "../notifications/upcoming-digest";
import type { BandGroup, UpcomingDomain, UpcomingItem } from "../upcoming";
import type { Reason } from "../reasons";

let n = 0;
const mk = (domain: UpcomingDomain): UpcomingItem => ({
  key: `${domain}:${n++}`,
  domain,
  title: domain,
  href: "/",
  dueDate: null,
});

// An item carrying a title, priority, and structured reasons (issue #656).
const mkReason = (
  domain: UpcomingDomain,
  title: string,
  priority: number,
  reasons: Reason[]
): UpcomingItem => ({
  key: `${domain}:${n++}`,
  domain,
  title,
  href: "/",
  dueDate: null,
  priority,
  reasons,
});

const band = (
  b: BandGroup["band"],
  label: string,
  domains: UpcomingDomain[]
): BandGroup => ({ band: b, label, items: domains.map(mk) });

describe("summarizeBand", () => {
  it("counts by domain and pluralizes, in fixed domain order", () => {
    const g = band("today", "Today", ["appointment", "dose", "dose"]);
    // dose comes before appointment in the fixed sequence.
    expect(summarizeBand(g)).toBe("2 doses, 1 appointment");
  });

  it("uses singular for a count of one", () => {
    expect(summarizeBand(band("overdue", "Overdue", ["biomarker"]))).toBe(
      "1 lab"
    );
  });

  it("names training targets and vaccines", () => {
    expect(
      summarizeBand(band("week", "This week", ["training", "immunization"]))
    ).toBe("1 vaccine, 1 training target");
  });

  it("drops excluded domains (#1108 — the digest excludes doses)", () => {
    const g = band("today", "Today", ["dose", "dose", "appointment"]);
    expect(summarizeBand(g, new Set<UpcomingDomain>(["dose"]))).toBe(
      "1 appointment"
    );
    // Excluding every present domain yields an empty summary (caller drops the line).
    expect(
      summarizeBand(
        band("today", "Today", ["dose"]),
        new Set<UpcomingDomain>(["dose"])
      )
    ).toBe("");
  });
});

describe("buildUpcomingDigest", () => {
  it("returns null when there is nothing due", () => {
    expect(buildUpcomingDigest("Sam", [])).toBeNull();
    expect(
      buildUpcomingDigest("Sam", [{ band: "today", label: "Today", items: [] }])
    ).toBeNull();
  });

  it("builds one line per non-empty band and a total", () => {
    const model = buildUpcomingDigest("Sam", [
      band("overdue", "Overdue", ["biomarker"]),
      band("today", "Today", ["dose", "dose", "appointment"]),
    ]);
    expect(model).not.toBeNull();
    expect(model!.total).toBe(4);
    expect(model!.title).toBe("🔔 Due soon — Sam");
    expect(model!.lines).toEqual([
      "Overdue: 1 lab",
      "Today: 2 doses, 1 appointment",
    ]);
  });

  it("omits the name from the title when profileName is empty", () => {
    const model = buildUpcomingDigest("", [band("today", "Today", ["dose"])]);
    expect(model!.title).toBe("🔔 Due soon");
  });

  it("excludeDomains drops those domains from the lines and empty bands (#1108)", () => {
    const model = buildUpcomingDigest(
      "Sam",
      [
        band("today", "Today", ["dose", "dose", "appointment"]),
        band("week", "This week", ["dose"]), // all-dose band → dropped
      ],
      { excludeDomains: ["dose"] }
    );
    // Doses gone from the lines; the all-dose "This week" band produces no line.
    expect(model!.lines).toEqual(["Today: 1 appointment"]);
    // `total` still counts every banded item, exclusion only trims the lines.
    expect(model!.total).toBe(4);
  });

  it("returns null when every due item is excluded", () => {
    expect(
      buildUpcomingDigest("Sam", [band("today", "Today", ["dose", "dose"])], {
        excludeDomains: ["dose"],
      })
    ).toBeNull();
  });
});

describe("digestHighlights (issue #656)", () => {
  const risk = (text: string): Reason => ({
    code: "risk-elevated",
    text,
    source: "ACC/AHA (informational)",
  });

  it("surfaces the top reason of high-priority reasoned items, highest priority first", () => {
    const groups: BandGroup[] = [
      {
        band: "overdue",
        label: "Overdue",
        items: [
          mkReason("biomarker", "Retest LDL Cholesterol", 2, [
            risk("Family history of heart disease"),
          ]),
        ],
      },
      {
        band: "today",
        label: "Today",
        items: [
          mkReason("dose", "Vitamin D", 0, [
            { code: "situation-active", text: "Due because Illness is active" },
          ]),
          mk("appointment"), // no reasons — not highlighted
        ],
      },
    ];
    expect(digestHighlights(groups)).toEqual([
      {
        title: "Retest LDL Cholesterol",
        reason: "Family history of heart disease",
      },
      { title: "Vitamin D", reason: "Due because Illness is active" },
    ]);
  });

  it("caps at three and de-dupes by title", () => {
    const items = [
      mkReason("biomarker", "A", 2, [risk("r1")]),
      mkReason("biomarker", "A", 2, [risk("r1")]), // dup title
      mkReason("biomarker", "B", 1, [risk("r2")]),
      mkReason("biomarker", "C", 1, [risk("r3")]),
      mkReason("biomarker", "D", 1, [risk("r4")]),
    ];
    const out = digestHighlights([
      { band: "overdue", label: "Overdue", items },
    ]);
    expect(out.map((h) => h.title)).toEqual(["A", "B", "C"]);
  });

  it("carries the highlight in the built model (rendered by the digest's Today section)", () => {
    const model = buildUpcomingDigest("Sam", [
      {
        band: "overdue",
        label: "Overdue",
        items: [
          mkReason("biomarker", "Retest LDL Cholesterol", 2, [
            risk("Family history of heart disease"),
          ]),
        ],
      },
    ])!;
    expect(model.highlights).toEqual([
      {
        title: "Retest LDL Cholesterol",
        reason: "Family history of heart disease",
      },
    ]);
  });
});

// ---- Naming a small band, and the per-domain phrase (#1819 items 4/5) -----

describe("summarizeBand — names a small band instead of counting it", () => {
  const named = (
    b: BandGroup["band"],
    label: string,
    entries: [UpcomingDomain, string][]
  ): BandGroup => ({
    band: b,
    label,
    items: entries.map(([domain, title]) => ({ ...mk(domain), title })),
  });

  it("names the items, peers by comma and domains by the middle dot", () => {
    const g = named("overdue", "Overdue", [
      ["screening", "Colonoscopy"],
      ["biomarker", "CBC"],
      ["biomarker", "Lipid panel"],
    ]);
    expect(summarizeBand(g, undefined, { nameAtMost: 3 })).toBe(
      "Colonoscopy · CBC, Lipid panel"
    );
  });

  it("falls back to counts once naming would stop fitting on a line", () => {
    const g = named("overdue", "Overdue", [
      ["biomarker", "CBC"],
      ["biomarker", "Lipid panel"],
      ["biomarker", "HbA1c"],
      ["biomarker", "TSH"],
    ]);
    expect(summarizeBand(g, undefined, { nameAtMost: 3 })).toBe("4 labs");
  });

  it("counts by default — naming is opt-in per surface", () => {
    const g = named("overdue", "Overdue", [["screening", "Colonoscopy"]]);
    expect(summarizeBand(g)).toBe("1 screening");
  });

  it("counts what the exclusion left, so an excluded domain cannot force a count", () => {
    const g = named("today", "Today", [
      ["dose", "Magnesium"],
      ["dose", "Vitamin D"],
      ["dose", "Creatine"],
      ["appointment", "Dentist"],
    ]);
    expect(
      summarizeBand(g, new Set<UpcomingDomain>(["dose"]), { nameAtMost: 3 })
    ).toBe("Dentist");
  });
});

describe("summarizeBand — a per-domain phrase replaces its count", () => {
  it("uses the phrase the caller supplies for that domain", () => {
    const g = band("week", "This week", ["training", "training", "goal"]);
    expect(
      summarizeBand(g, undefined, {
        phraseFor: (d) => (d === "training" ? "2 of 4 on pace" : null),
      })
    ).toBe("1 goal, 2 of 4 on pace");
  });

  it("hands the domain's items over so the caller can decline", () => {
    const g = band("week", "This week", ["training", "training"]);
    const seen: number[] = [];
    summarizeBand(g, undefined, {
      phraseFor: (_d, items) => {
        seen.push(items.length);
        return null;
      },
    });
    expect(seen).toEqual([2]);
  });
});

// ---- One entry per named-line item (#1913 items 2, 5, 6, 7, 8) -------------
//
// The reported message carried the SAME 503 twice: "📝 Today: Weather & UV sync needs
// attention" (the band count, which #1819 item 5 had already turned into a name) over
// "🔌 Weather & UV sync needs attention — weather fetch failed (503)". The merge is keyed
// on the named-line DOMAINS rather than on the weather standing, because both members of
// that set were counted and named — a weather-shaped fix would have left the portal
// double-mentioning the moment it closed.

describe("named-line domains merge their band entry into the named line (#1913)", () => {
  const namedLineItem = (
    domain: UpcomingDomain,
    over: Partial<UpcomingItem> = {}
  ): UpcomingItem => ({ ...mk(domain), ...over });

  const groupOf = (items: UpcomingItem[]): BandGroup[] => [
    { band: "today", label: "Today", items },
  ];

  // DOMAIN-PARAMETRIZED on purpose: proven for both members rather than for weather with
  // the portal assumed to follow.
  for (const domain of ["integration", "portal-sync"] as const) {
    it(`gives a ${domain} item exactly ONE entry`, () => {
      const model = buildUpcomingDigest(
        "Sam",
        groupOf([
          namedLineItem(domain, {
            title: "Weather & UV sync needs attention",
            because: "weather fetch failed (503)",
          }),
        ])
      )!;
      expect(model.syncIssues).toHaveLength(1);
      // No band line at all: the named line IS the band item.
      expect(model.lines).toEqual([]);
      // …but the item is still counted in the total.
      expect(model.total).toBe(1);
    });

    it(`keeps a ${domain} item out of a band that also holds real work`, () => {
      const model = buildUpcomingDigest(
        "Sam",
        groupOf([namedLineItem(domain), mk("appointment")])
      )!;
      expect(model.lines).toEqual(["Today: 1 appointment"]);
      expect(model.syncIssues).toHaveLength(1);
    });
  }

  it("still returns a model when a named line is the day's only content", () => {
    // #1685's load-bearing case: returning null here would drop the named line along
    // with the count and leave the dead integration reaching nothing again.
    const model = buildUpcomingDigest(
      "Sam",
      groupOf([namedLineItem("integration")])
    );
    expect(model).not.toBeNull();
    expect(model!.syncIssues).toHaveLength(1);
  });

  it("carries the glyph that says WHO ACTS (item 8)", () => {
    const model = buildUpcomingDigest(
      "Sam",
      groupOf([
        namedLineItem("integration"),
        namedLineItem("portal-sync", { dueText: "expires in 6 days" }),
      ])
    )!;
    // 🔌 keeps its meaning — a connection broke and allos will keep retrying. A line only
    // a person can close, away from the device reading it, gets 🙋.
    expect(model.syncIssues.map((s) => s.glyph)).toEqual(["🔌", "🙋"]);
  });

  it("carries the producer's cause fragment, never the card's sentence (item 6)", () => {
    const model = buildUpcomingDigest(
      "Sam",
      groupOf([
        namedLineItem("portal-sync", {
          title: "Run the portal tool for tbh",
          // What the CARD renders under its heading — a complete sentence that
          // re-contains the title.
          detail:
            "tbh has never been checked — run the portal tool on your computer.",
          because: "never checked",
        }),
      ])
    )!;
    expect(model.syncIssues[0].because).toBe("never checked");
  });

  it("carries the expiry only for the domain that HAS one (item 7)", () => {
    const model = buildUpcomingDigest(
      "Sam",
      groupOf([
        // A broken integration's dueText is a CTA label, not a deadline — nothing
        // expires, and printing "Reconnect" after a middle dot would invent one.
        namedLineItem("integration", { dueText: "Reconnect" }),
        namedLineItem("portal-sync", { dueText: "expires in 6 days" }),
      ])
    )!;
    expect(model.syncIssues.map((s) => s.dueText)).toEqual([
      null,
      "expires in 6 days",
    ]);
  });
});
