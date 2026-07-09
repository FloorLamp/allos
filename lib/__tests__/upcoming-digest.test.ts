import { describe, it, expect } from "vitest";
import {
  buildUpcomingDigest,
  renderUpcomingDigestMessage,
  summarizeBand,
} from "../notifications/upcoming-digest";
import type { BandGroup, UpcomingDomain, UpcomingItem } from "../upcoming";

let n = 0;
const mk = (domain: UpcomingDomain): UpcomingItem => ({
  key: `${domain}:${n++}`,
  domain,
  title: domain,
  href: "/",
  dueDate: null,
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
    expect(msg.body).toBe("Overdue: 1 lab\nToday: 1 dose");
  });
});
