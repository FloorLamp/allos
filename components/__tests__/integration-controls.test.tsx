import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import IntegrationActionButton from "@/components/integrations/IntegrationActionButton";
import IntegrationDisconnectButton from "@/components/integrations/IntegrationDisconnectButton";
import { INTEGRATION_BACKFILL_STARTED_EVENT } from "@/components/integrations/IntegrationBackfillProgress";

const toast = vi.hoisted(() => vi.fn());
const actions = vi.hoisted(() => ({
  sync: vi.fn(),
  backfill: vi.fn(),
  recheck: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));
vi.mock("@/app/(app)/integrations/sync-actions", () => ({
  syncNow: actions.sync,
}));
vi.mock("@/app/(app)/integrations/strava/actions", () => ({
  backfillStravaRideDetails: actions.backfill,
  recheckStravaEmptySessions: actions.recheck,
}));

describe("integration action controls", () => {
  it("owns pending state and reports a successful sync", async () => {
    const result = Promise.withResolvers<{
      status: "done";
      message: string;
    }>();
    actions.sync.mockReturnValueOnce(result.promise);
    render(<IntegrationActionButton kind="sync" sourceId="strava" />);

    fireEvent.click(screen.getByTestId("sync-now-strava"));
    await waitFor(() =>
      expect(screen.getByRole("button").textContent).toBe("Syncing…")
    );
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);

    await act(async () =>
      result.resolve({ status: "done", message: "Synced" })
    );
    expect(toast).toHaveBeenLastCalledWith("Synced", { tone: "success" });
  });

  it("keeps counts, error results, and the Strava start signal semantic", async () => {
    const started = vi.fn();
    window.addEventListener(INTEGRATION_BACKFILL_STARTED_EVENT, started, {
      once: true,
    });
    actions.backfill
      .mockResolvedValueOnce({ status: "error", message: "Try later" })
      .mockResolvedValueOnce({ status: "done", message: "Backfill started" });
    const view = render(<IntegrationActionButton kind="backfill" count={7} />);
    expect(screen.getByRole("button").textContent).toContain("7");

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(toast).toHaveBeenLastCalledWith("Try later", { tone: "error" })
    );
    expect(started).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(toast).toHaveBeenLastCalledWith("Backfill started", {
      tone: "success",
    });

    view.rerender(<IntegrationActionButton kind="recheck" count={3} />);
    expect(screen.getByTestId("strava-recheck-empty").textContent).toContain(
      "3"
    );
    view.rerender(<IntegrationActionButton kind="recheck" count={0} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("integration disconnect controls", () => {
  it("binds a callback and owns its pending state", async () => {
    const result = Promise.withResolvers<void>();
    const action = vi.fn(() => result.promise);
    render(
      <IntegrationDisconnectButton kind="family-feed" onDisconnect={action} />
    );
    const button = screen.getByTestId("family-feed-disable");
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Disabling…"));
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(action).toHaveBeenCalledOnce();
    await act(async () => result.resolve());
    await waitFor(() => expect(button.textContent).toBe("Disable family feed"));
  });

  it("binds a Server Action through its owned form", async () => {
    const action = vi.fn(async (_formData: FormData) => {});
    render(
      <IntegrationDisconnectButton kind="disconnect" serverAction={action} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(action.mock.calls[0][0]).toBeInstanceOf(FormData);
  });
});
