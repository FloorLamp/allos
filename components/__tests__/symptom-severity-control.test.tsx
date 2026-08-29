import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SymptomSeverityControl from "@/components/illness/SymptomSeverityControl";

describe("SymptomSeverityControl", () => {
  it("derives the fixed 1–4 options, names and pressed state", () => {
    render(
      <SymptomSeverityControl
        symptomLabel="Headache"
        value={2}
        onChange={() => {}}
        testIdPrefix="symptom-headache-sev"
      />
    );

    const group = screen.getByRole("group", { name: "Headache severity" });
    const options = screen.getAllByRole("button");
    expect(group.className).toBe("inline-flex items-center gap-3");
    expect(options).toHaveLength(4);
    expect(options.map((option) => option.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(
      screen
        .getByRole("button", {
          name: "Headache — severity 2 of 4 (Moderate)",
        })
        .getAttribute("aria-pressed")
    ).toBe("true");
    // The control box on both axes plus the reach mechanism (#3954); the
    // RENDERED proof is e2e/button-height-floor.mobile.spec.ts, since a class
    // string is not evidence a rule reached the element.
    expect(options[0]?.className).toContain("h-(--control-box)");
    expect(options[0]?.className).toContain("w-(--control-box)");
    expect(options[0]?.className).toContain("tap-target");
    expect(options[0]?.className).toContain("bg-brand-600");
    expect(options[2]?.className).toContain("bg-slate-100");
    expect(options[3]?.getAttribute("data-testid")).toBe(
      "symptom-headache-sev-4"
    );
  });

  it("reports the selected domain value", () => {
    const onChange = vi.fn();
    render(
      <SymptomSeverityControl
        symptomLabel="Cough"
        value={1}
        onChange={onChange}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cough — severity 4 of 4 (Very severe)",
      })
    );
    expect(onChange).toHaveBeenCalledWith(4);
  });
});
