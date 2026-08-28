import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DoseStatusControl from "@/components/DoseStatusControl";
import ScheduledDoseAction from "@/components/medications/ScheduledDoseAction";

vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: vi.fn(),
  }),
}));
vi.mock("@/components/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => false,
}));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  setDoseStatus: vi.fn(),
}));

function renderPill(state: "clear" | "taken" | "skipped") {
  return render(
    <DoseStatusControl
      doseId={7}
      taken={state === "taken"}
      skipped={state === "skipped"}
      variant="pill"
      label={state === "taken" ? "Taken" : "Mark taken"}
      compact
    />
  );
}

describe("DoseStatusControl", () => {
  it.each([
    {
      state: "clear" as const,
      takeName: "Mark taken",
      takePressed: "false",
      skipName: "Skip this dose",
      skipPressed: "false",
    },
    {
      state: "taken" as const,
      takeName: "Mark not taken",
      takePressed: "true",
      skipName: "Skip this dose",
      skipPressed: "false",
    },
    {
      state: "skipped" as const,
      takeName: "Mark taken",
      takePressed: "false",
      skipName: "Undo skip",
      skipPressed: "true",
    },
  ])(
    "keeps the $state pill semantics inside one closed geometry contract",
    ({ state, takeName, takePressed, skipName, skipPressed }) => {
      renderPill(state);

      const control = screen.getByTestId("dose-status");
      expect(control.getAttribute("data-variant")).toBe("pill");
      expect(control.className).toBe(
        "flex shrink-0 items-center -m-1.5 gap-3 p-1.5 sm:pointer-fine:m-0 sm:pointer-fine:gap-1.5 sm:pointer-fine:p-0"
      );

      const take = screen.getByRole("button", { name: takeName });
      const skip = screen.getByRole("button", { name: skipName });
      expect(take.getAttribute("type")).toBe("button");
      expect(skip.getAttribute("type")).toBe("button");
      expect(take.getAttribute("aria-pressed")).toBe(takePressed);
      expect(skip.getAttribute("aria-pressed")).toBe(skipPressed);
      expect(take.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["tap-target", "h-8"])
      );
      expect(skip.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["tap-target", "h-8"])
      );
    }
  );

  it("coordinates the pill reserve with its owning scheduled-dose row", () => {
    render(
      <ScheduledDoseAction
        doseId={9}
        doseLabel="Morning"
        taken={false}
        skipped={false}
      />
    );

    expect(screen.getByTestId("scheduled-dose-action").className).toBe(
      "flex w-full flex-wrap items-center justify-between gap-2 -my-1.5 p-1.5 sm:pointer-fine:my-0 sm:pointer-fine:p-0"
    );
  });

  it("keeps the rendered 44px circle treatment without an overlay reserve", () => {
    render(
      <DoseStatusControl
        doseId={8}
        taken={false}
        skipped={false}
        variant="circle"
      />
    );

    const control = screen.getByTestId("dose-status");
    // The circles render the control box and the container reserves the reach, the
    // same geometry the pill variant already shipped (#3938).
    expect(control.className).toBe("flex shrink-0 items-center -m-1.5 gap-3 p-1.5");
    for (const button of screen.getAllByRole("button")) {
      expect(button.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["h-(--control-box)", "w-(--control-box)"])
      );
      expect(button.className.split(/\s+/)).toContain("tap-target");
    }
  });
});
