import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import OverlayDestination from "@/components/OverlayDestination";

describe("OverlayDestination", () => {
  it("keeps a full-surface destination and detail control as siblings", () => {
    render(
      <OverlayDestination href="/data" label="Open data">
        <p>Last sync</p>
        <InfoTooltipIcon label="Aug 26, 2026 at 10:00 AM" />
      </OverlayDestination>
    );

    const destination = screen.getByRole("link", { name: "Open data" });
    const detail = screen.getByRole("button", {
      name: "Aug 26, 2026 at 10:00 AM",
    });
    expect(destination.contains(detail)).toBe(false);
    expect(
      destination.parentElement
        ?.querySelector("[data-overlay-destination-content]")
        ?.contains(detail)
    ).toBe(true);
  });

  // THE SECOND CASE HERE MOUNTED `RecentSessions`, which #4079 retired as a
  // duplicate of the Log mount's first screen. Its subject — a disclosure control
  // living OUTSIDE its card's whole-header link — is still covered by the case above
  // against the primitive itself, and by the four surviving consumers (ProtocolList,
  // ConnectedSources, IntegrationSyncHistoryLink, IntegrationsGrid) through
  // e2e/title-disclosure.mobile.spec.ts.
});
