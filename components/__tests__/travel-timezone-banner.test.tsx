import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TravelTimezoneBanner from "../TravelTimezoneBanner";

const actions = vi.hoisted(() => ({
  acceptTravelTimezone: vi.fn(),
  dismissTravelTimezone: vi.fn(),
  revertTravelTimezone: vi.fn(),
}));

vi.mock("@/app/(app)/travel-actions", () => actions);

const NY = "America/New_York";
const HONOLULU = "Pacific/Honolulu";
const LA = "America/Los_Angeles";

let reportedZone = NY;

beforeEach(() => {
  reportedZone = NY;
  actions.acceptTravelTimezone.mockReset();
  actions.dismissTravelTimezone.mockReset();
  actions.revertTravelTimezone.mockReset();
  actions.acceptTravelTimezone.mockResolvedValue({ ok: true, timezone: LA });
  actions.dismissTravelTimezone.mockResolvedValue({ ok: true });
  actions.revertTravelTimezone.mockResolvedValue({
    ok: true,
    timezone: NY,
    homeZone: NY,
    awayZone: HONOLULU,
  });
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
    () => ({
      locale: "en-US",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: reportedZone,
    })
  );
});

afterEach(() => vi.restoreAllMocks());

function banner(profileZone: string, homeZone: string | null) {
  return (
    <TravelTimezoneBanner
      ownProfile
      profileZone={profileZone}
      homeZone={homeZone}
      dismissedZone={null}
    />
  );
}

function resumeIn(zone: string): void {
  reportedZone = zone;
  act(() => window.dispatchEvent(new Event("focus")));
}

describe("a mounted travel banner spends successful dismissals (#3684)", () => {
  it("re-offers New York after dismissing it, accepting Los Angeles, and returning", async () => {
    const view = render(banner(HONOLULU, NY));
    expect(
      screen
        .getByTestId("travel-timezone-banner")
        .getAttribute("data-device-zone")
    ).toBe(NY);

    await act(async () => {
      fireEvent.click(screen.getByTestId("travel-timezone-dismiss"));
    });
    expect(screen.queryByTestId("travel-timezone-banner")).toBeNull();
    expect(actions.dismissTravelTimezone).toHaveBeenCalledWith(NY);

    // This is one mounted PWA throughout. Focus is the production resume path
    // that re-reads a changed browser zone; rerender is the Server Action's RSC
    // response changing the profile props without remounting client state.
    resumeIn(LA);
    expect(
      screen
        .getByTestId("travel-timezone-banner")
        .getAttribute("data-device-zone")
    ).toBe(LA);
    await act(async () => {
      fireEvent.click(screen.getByTestId("travel-timezone-accept"));
    });
    expect(actions.acceptTravelTimezone).toHaveBeenCalledWith(LA);
    view.rerender(banner(LA, NY));
    expect(screen.queryByTestId("travel-timezone-banner")).toBeNull();

    resumeIn(NY);
    expect(screen.getByTestId("travel-timezone-banner").textContent).toContain(
      "move your day back?"
    );
  });

  it("spends an earlier outbound dismissal when the return succeeds", async () => {
    reportedZone = LA;
    const view = render(banner(HONOLULU, NY));
    await act(async () => {
      fireEvent.click(screen.getByTestId("travel-timezone-dismiss"));
    });
    expect(actions.dismissTravelTimezone).toHaveBeenCalledWith(LA);

    resumeIn(NY);
    await act(async () => {
      fireEvent.click(screen.getByTestId("travel-timezone-accept"));
    });
    expect(actions.revertTravelTimezone).toHaveBeenCalledOnce();
    view.rerender(banner(NY, null));
    expect(screen.queryByTestId("travel-timezone-banner")).toBeNull();

    resumeIn(LA);
    expect(
      screen
        .getByTestId("travel-timezone-banner")
        .getAttribute("data-device-zone")
    ).toBe(LA);
  });

  it("keeps the mounted dismissal when the switch is refused", async () => {
    reportedZone = LA;
    render(banner(HONOLULU, NY));
    await act(async () => {
      fireEvent.click(screen.getByTestId("travel-timezone-dismiss"));
    });

    resumeIn(NY);
    actions.revertTravelTimezone.mockResolvedValue({ ok: false });
    await act(async () => {
      fireEvent.click(screen.getByTestId("travel-timezone-accept"));
    });
    expect(actions.revertTravelTimezone).toHaveBeenCalledOnce();

    // The refused action did not spend the server dismissal, so its mounted
    // counterpart must still answer Los Angeles when that zone reports again.
    resumeIn(LA);
    expect(screen.queryByTestId("travel-timezone-banner")).toBeNull();
  });
});
