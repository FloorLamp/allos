import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import EquipmentTrend from "@/components/EquipmentTrend";

describe("EquipmentTrend", () => {
  it("renders one dated value as the shared captioned mark", () => {
    const { container } = render(
      <EquipmentTrend
        points={[5.25]}
        label="Distance per session"
        ariaLabel="Usage trend for Bike"
        loneCaption="Single reading · 5.25 mi · Aug 29"
      />
    );

    expect(
      screen.getByText("Single reading · 5.25 mi · Aug 29")
    ).not.toBeNull();
    expect(screen.getByTestId("equipment-trend-single-reading")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("keeps two readings on the existing sparkline path", () => {
    const { container } = render(
      <EquipmentTrend
        points={[4, 5.25]}
        label="Distance per session"
        ariaLabel="Usage trend for Bike"
        loneCaption="unused"
      />
    );

    expect(
      container.querySelector('svg[aria-label="Usage trend for Bike"]')
    ).toBeTruthy();
    expect(container.querySelector("svg path")?.getAttribute("d")).toBe(
      "M4.0,15.4 L276.0,4.0"
    );
    expect(screen.queryByTestId("equipment-trend-single-reading")).toBeNull();
  });
});
