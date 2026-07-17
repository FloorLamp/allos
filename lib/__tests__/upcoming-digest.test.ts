import { describe, it, expect } from "vitest";
import {
  buildUpcomingDigest,
  digestHighlights,
  renderUpcomingDigestMessage,
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

  it("renders the model to a title + newline-joined body", () => {
    const model = buildUpcomingDigest("Sam", [
      band("overdue", "Overdue", ["biomarker"]),
      band("today", "Today", ["dose"]),
    ])!;
    const msg = renderUpcomingDigestMessage(model);
    expect(msg.title).toBe("🔔 Due soon — Sam");
    // No structured reasons on the fixture items ⇒ no highlight block, body unchanged.
    expect(model.highlights).toEqual([]);
    expect(msg.body).toBe("Overdue: 1 lab\nToday: 1 dose");
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

  it("renders highlight lines after a blank line in the message body", () => {
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
    const msg = renderUpcomingDigestMessage(model);
    expect(msg.body).toBe(
      "Overdue: 1 lab\n\n⚑ Retest LDL Cholesterol — Family history of heart disease"
    );
  });
});
