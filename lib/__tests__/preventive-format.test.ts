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

  it("keeps the informational disclaimer on every nudge", () => {
    expect(renderPreventiveMessage("Ada", item(), 3).body).toContain(
      "Informational only — not medical advice."
    );
  });
});
