import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import VisualizationDetails from "@/components/VisualizationDetails";

describe("VisualizationDetails", () => {
  it("keeps every visual value behind one keyboard and touch disclosure", () => {
    render(
      <VisualizationDetails
        label="Weekly details"
        items={["Aug 3–9 · met", "Aug 10–16 · below target"]}
      />
    );

    const trigger = screen.getByText("Weekly details");
    expect(trigger.tagName).toBe("SUMMARY");
    const details = trigger.closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
    fireEvent.click(trigger);
    expect(details?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Aug 3–9 · met")).toBeTruthy();
    expect(screen.getByText("Aug 10–16 · below target")).toBeTruthy();
    expect(trigger.classList.contains("button-control")).toBe(true);
    expect(trigger.classList.contains("min-h-11!")).toBe(true);
  });

  it("renders nothing for an empty visualization", () => {
    const { container } = render(
      <VisualizationDetails label="Details" items={[]} />
    );
    expect(container.innerHTML).toBe("");
  });
});
