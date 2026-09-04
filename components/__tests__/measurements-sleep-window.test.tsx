import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";

// THE NIGHT'S TWO CLOCKS, ON `TimeRangeFields` (#4976 item 2).
//
// The Bed & wake pair swapped two native `<input type="time">` for a
// `TimeRangeFields` mount in `overnight` mode. Three claims this pins, matching the
// issue's own acceptance criteria: the write still reads `bed_time`/`wake_time`
// exactly as before (the pair posts through TimeField's own hidden inputs under
// those unchanged names); a wake earlier than bed is ACCEPTED, not refused, because
// that is the whole point of a night's pair; and the two fields keep the labels
// `e2e/manual-vitals.spec.ts` already locates them by.

const posted: FormData[] = [];

vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: async (fd: FormData) => {
    posted.push(fd);
    return {};
  },
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => () => {},
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  posted.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  cleanup();
});

function mountOpenToSleep() {
  render(
    <MeasurementsQuickAdd
      defaultDate="2026-05-20"
      weightUnit="kg"
      defaultGroup="sleep"
    />
  );
}

describe("the Bed & wake pair on TimeRangeFields (#4976)", () => {
  it("keeps its Bed time / Wake time labels", () => {
    mountOpenToSleep();
    expect(screen.getByLabelText("Bed time")).toBeTruthy();
    expect(screen.getByLabelText("Wake time")).toBeTruthy();
  });

  it("accepts a wake earlier than bed and posts the pair unchanged (#4976)", async () => {
    mountOpenToSleep();
    fireEvent.change(screen.getByLabelText("Bed time"), {
      target: { value: "22:32" },
    });
    fireEvent.change(screen.getByLabelText("Wake time"), {
      target: { value: "06:22" },
    });
    // Overnight is ACCEPTED — no refusal text, and the span is reported.
    expect(
      screen.queryByText("End time must be after the start time.")
    ).toBeNull();
    expect(screen.getByTestId("time-range-span").textContent).toBe("7h 50m");

    await act(async () => {
      fireEvent.submit(screen.getByTestId("measurements-quick-add"));
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].get("bed_time")).toBe("22:32");
    expect(posted[0].get("wake_time")).toBe("06:22");
  });

  it("clears both clocks after a successful save (#4976)", async () => {
    mountOpenToSleep();
    fireEvent.change(screen.getByLabelText("Bed time"), {
      target: { value: "22:00" },
    });
    fireEvent.change(screen.getByLabelText("Wake time"), {
      target: { value: "06:00" },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("measurements-quick-add"));
    });
    expect((screen.getByLabelText("Bed time") as HTMLInputElement).value).toBe(
      ""
    );
    expect((screen.getByLabelText("Wake time") as HTMLInputElement).value).toBe(
      ""
    );
  });
});
