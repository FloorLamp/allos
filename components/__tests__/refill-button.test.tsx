import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RefillButton from "@/components/medications/RefillButton";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";

const refill = vi.hoisted(() =>
  vi.fn(async (_form: FormData) => ({
    ok: true as const,
    fillSize: 30,
    newQuantity: 32,
  }))
);
vi.mock("@/app/(app)/medications/actions", () => ({
  refillMedication: refill,
}));

function mount(initialAsk: boolean, lastFillSize: number | null) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <RefillButton
          itemId={17}
          supplyId={4}
          hasLastFill={lastFillSize != null}
          lastFillSize={lastFillSize}
          initialAsk={initialAsk}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("shared refill control", () => {
  it("opens the search first-size prompt without writing, then posts the displayed item and bottle", async () => {
    refill.mockClear();
    mount(true, null);
    expect(refill).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Fill size (units)"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByTestId("refill-confirm"));
    await waitFor(() => expect(refill).toHaveBeenCalledOnce());
    expect(Object.fromEntries(refill.mock.calls[0][0])).toEqual({
      id: "17",
      supply_id: "4",
      fill_size: "30",
    });
    expect((await screen.findByTestId("refill-recency")).textContent).toContain(
      "+30"
    );
  });

  it("uses the existing remembered-size action without asking for a total count", async () => {
    refill.mockClear();
    mount(false, 30);
    expect(screen.queryByTestId("refill-size")).toBeNull();
    fireEvent.click(screen.getByTestId("refill-button"));
    await waitFor(() => expect(refill).toHaveBeenCalledOnce());
    expect(Object.fromEntries(refill.mock.calls[0][0])).toEqual({
      id: "17",
      supply_id: "4",
    });
  });
});
