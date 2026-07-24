import { describe, expect, it } from "vitest";
import { renderPreventiveMessage } from "@/lib/notifications/preventive-format";
import type { PreventiveNudgeItem } from "@/lib/preventive-nudge";

const item = (
  over: Partial<PreventiveNudgeItem> = {}
): PreventiveNudgeItem => ({
  ruleKey: "colorectal_cancer",
  name: "Colorectal cancer screening",
  status: "due",
  detail: null,
  href: "/records/history/procedures?new=1&name=Colonoscopy",
  ctaLabel: "Log or schedule a Colonoscopy",
  ...over,
});

describe("renderPreventiveMessage", () => {
  it("renders ONE screening per message, named in the title", () => {
    const msg = renderPreventiveMessage("Ada", item(), 3);
    expect(msg.title).toBe(
      "🩺 Preventive care: Ada — Colorectal cancer screening"
    );
    expect(msg.body).toContain("Colorectal cancer screening: Due");
    expect(msg.kind).toBe("preventive");
  });

  it("carries exactly one ✅/🚫/⏰ row keyed by the rule, so buttons attach to the named screening", () => {
    // No public URL ⇒ no deep-link button, just the three callbacks.
    const msg = renderPreventiveMessage("Ada", item(), 3);
    expect(msg.actions).toHaveLength(3);
    const rows = new Set(msg.actions!.map((a) => a.row));
    expect(rows).toEqual(new Set(["pv:colorectal_cancer"]));
    expect(msg.actions!.map((a) => a.data)).toEqual([
      "pvdone:3:colorectal_cancer",
      "pvna:3:colorectal_cancer",
      "pvlater:3:colorectal_cancer",
    ]);
  });

  it("marks an overdue item and appends its detail", () => {
    const msg = renderPreventiveMessage(
      "",
      item({ status: "overdue", detail: "last done 2019" }),
      3
    );
    expect(msg.title).toBe(
      "🩺 Preventive care: Colorectal cancer screening" // no profile prefix
    );
    expect(msg.body).toContain(
      "Colorectal cancer screening: Overdue — last done 2019"
    );
  });

  it("carries no disclaimer boilerplate — that lives on /disclaimer now (#1049)", () => {
    expect(renderPreventiveMessage("Ada", item(), 3).body).not.toMatch(
      /not medical advice/i
    );
  });

  describe("deep-link action (#1083)", () => {
    it("prepends a url action with the absolute per-class deep link + the CTA label", () => {
      const msg = renderPreventiveMessage(
        "Ada",
        item(),
        3,
        "https://allos.example"
      );
      // Deep link is FIRST (above the state-change row), carries the CTA label +
      // the absolute per-class URL, and — being a url action — has no callback token.
      expect(msg.actions).toHaveLength(4);
      const cta = msg.actions![0];
      expect(cta.label).toBe("Log or schedule a Colonoscopy");
      expect(cta.url).toBe(
        "https://allos.example/records/history/procedures?new=1&name=Colonoscopy"
      );
      expect(cta.data).toBeUndefined();
      // The three callbacks still follow, unchanged.
      expect(msg.actions!.slice(1).map((a) => a.data)).toEqual([
        "pvdone:3:colorectal_cancer",
        "pvna:3:colorectal_cancer",
        "pvlater:3:colorectal_cancer",
      ]);
    });

    it("strips a trailing slash on the base so the URL never doubles", () => {
      const msg = renderPreventiveMessage(
        "Ada",
        item(),
        3,
        "https://allos.example/"
      );
      expect(msg.actions![0].url).toBe(
        "https://allos.example/records/history/procedures?new=1&name=Colonoscopy"
      );
    });

    it("carries a lab class deep link + Record CTA", () => {
      const msg = renderPreventiveMessage(
        "Ada",
        item({
          ruleKey: "lipid_screening",
          name: "Cholesterol (lipid) screening",
          href: "/results/biomarkers?new=1&name=LDL%20Cholesterol",
          ctaLabel: "Record your LDL Cholesterol result",
        }),
        3,
        "https://allos.example"
      );
      expect(msg.actions![0].label).toBe("Record your LDL Cholesterol result");
      expect(msg.actions![0].url).toBe(
        "https://allos.example/results/biomarkers?new=1&name=LDL%20Cholesterol"
      );
    });

    it("passes an instrument CTA through verbatim (DAST-10 — in-app since #1085)", () => {
      const msg = renderPreventiveMessage(
        "Ada",
        item({
          ruleKey: "drug_use_screening",
          name: "Drug use screening",
          href: "/records/specialty/substance-use?screen=DAST-10",
          ctaLabel: "Complete the DAST-10",
        }),
        3,
        "https://allos.example"
      );
      expect(msg.actions![0].label).toBe("Complete the DAST-10");
      expect(msg.actions![0].url).toBe(
        "https://allos.example/records/specialty/substance-use?screen=DAST-10"
      );
    });

    it("omits the link button when no public URL is configured (relative can't be a Telegram button)", () => {
      const msg = renderPreventiveMessage("Ada", item(), 3, "");
      expect(msg.actions).toHaveLength(3);
      expect(msg.actions!.every((a) => a.url == null)).toBe(true);
    });

    it("omits the link button for an unmapped rule with no concrete action", () => {
      const msg = renderPreventiveMessage(
        "Ada",
        item({ href: null, ctaLabel: null }),
        3,
        "https://allos.example"
      );
      expect(msg.actions).toHaveLength(3);
      expect(msg.actions!.every((a) => a.url == null)).toBe(true);
    });
  });
});
