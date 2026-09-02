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
      label={state === "taken" ? "Taken" : "Take"}
      compact
    />
  );
}

describe("DoseStatusControl", () => {
  it.each([
    {
      state: "clear" as const,
      takeName: "Take",
      takePressed: "false",
      skipName: "Skip this dose",
      skipPressed: "false",
    },
    {
      state: "taken" as const,
      takeName: "Undo take",
      takePressed: "true",
      skipName: "Skip this dose",
      skipPressed: "false",
    },
    {
      state: "skipped" as const,
      takeName: "Take",
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
      // The control box, not a pill size of its own (#3938) — the same token the
      // circle variant carries, so neither variant can drift from the other.
      expect(take.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["tap-target", "h-(--control-box)"])
      );
      expect(skip.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["tap-target", "h-(--control-box)"])
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
    expect(control.className).toBe(
      "flex shrink-0 items-center -m-1.5 gap-3 p-1.5"
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["h-(--control-box)", "w-(--control-box)"])
      );
      expect(button.className.split(/\s+/)).toContain("tap-target");
    }
  });
});

// ── THE OFFER ARM, AND THE THREE THINGS THAT TURN IT OFF (#4753) ────────────
//
// Owner ruling 1 says a control with nothing non-redundant left to show is NOT this
// primitive, and ruling 3 says there is no label-less variant. Both of those are
// SILENCES — the chip simply does not appear — so each is forged here beside the case
// that does appear. A silence asserted alone passes on the tree where the arm never
// works at all.
describe("DoseStatusControl's labeled-verb arm (issue #4753)", () => {
  function renderArm(props: Partial<Parameters<typeof DoseStatusControl>[0]>) {
    return render(
      <DoseStatusControl
        doseId={11}
        taken={false}
        skipped={false}
        variant="pill"
        {...props}
      />
    );
  }

  it("shows the payload on the pill and names the act beside it", () => {
    renderArm({ payload: "8:00am" });

    const take = screen.getByTestId("dose-take");
    // ONE TARGET: the verb is a span inside the pill, so the row grows no second
    // tab stop for the nub.
    expect(take.tagName).toBe("BUTTON");
    expect(take.querySelectorAll("button")).toHaveLength(0);
    expect(take.textContent).toBe("8:00amTake");
    expect(take.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["chip-base", "chip-offer"])
    );
    // The name a reader hears is the label they see, in the order they see it.
    expect(take.getAttribute("aria-label")).toBe("8:00am · Take");
    // An offer is never "on" — a chip that could look selected would be the filter
    // chip's grammar wearing the action chip's paint.
    expect(take.getAttribute("aria-pressed")).toBeNull();
    // The skip stays exactly where it was: this arm replaces the take, not the row.
    expect(screen.getByTestId("dose-skip")).toBeTruthy();
  });

  it.each([
    // [why the chip stands down, the props that make it, what the take renders as]
    ["no payload to show (ruling 1)", {}],
    ["an icon-only arm (ruling 3)", { payload: "8:00am", compact: true }],
    [
      "a circle arm (ruling 3)",
      { payload: "8:00am", variant: "circle" as const },
    ],
    [
      "a dose already taken — a receipt, not an offer",
      { payload: "8:00am", taken: true },
    ],
    [
      "a dose already skipped — a receipt, not an offer",
      { payload: "8:00am", skipped: true },
    ],
  ])("stands down for %s", (_why, props) => {
    renderArm(props);

    const take = screen.getByTestId("dose-take");
    expect(take.className).not.toContain("chip-offer");
    // The pill it falls back to is the tri-state's own button, which is what carries
    // the pressed state and the resolved treatment the receipt is made of.
    expect(take.getAttribute("aria-pressed")).not.toBeNull();
  });
});
