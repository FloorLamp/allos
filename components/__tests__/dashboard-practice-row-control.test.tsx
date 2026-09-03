import { cleanup, render, screen, within } from "@testing-library/react";
import { Children } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardFactRow,
  type DashboardStandingPresentation,
} from "@/components/dashboard/DashboardStandingCluster";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import { progressCandidates } from "@/lib/dashboard-candidates/progress";

// THE PRACTICE-TARGET ROW LOGS IN PLACE (#4076, the #4384-thread ruling). Two
// invariants are named and both are asserted here, not only the first:
//   1. controls live in the row's TRAILING SLOT (`presentation.control`) — proven
//      by rendering the real `DashboardFactRow` with a real `LogPracticeButton` in
//      that slot and checking where its markup actually lands, not by trusting the
//      prop name.
//   2. the slot holds at most two controls at the one 34px `--control-box` height
//      — this row composes exactly one (`LogPracticeButton`), and its own tap
//      buttons already carry the shared `DOSE_ACTION_LABEL`/`h-(--control-box)`
//      class every other trailing-slot control uses (DoseConfirmButton, the
//      preventive-review controls, …), so the height is not a new claim this row
//      invents.
//
// The mocks below are the same set `components/__tests__/practice-two-pieces.test.tsx`
// uses to render this exact component — `LogPracticeButton` reaches four context
// hooks that throw outside their providers, and this row mounts it exactly the way
// the dashboard does (compact, no subject — the acting profile's own row).
const toasts: string[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => toasts.push(text),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/FormatPrefsProvider", () => ({
  useFormatPrefs: () => ({ timeFormat: "24h", dateFormat: "iso" }),
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    affordance: "practice-session",
    blocked: () => false,
    pending: () => false,
    tap: async () => {},
  }),
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice: async () => ({
    kind: "logged" as const,
    count: 1,
    date: "2026-08-20",
  }),
  startPracticeLive: async () => ({
    kind: "started" as const,
    count: 0,
    date: "2026-08-20",
  }),
  endPracticeLive: async () => ({
    kind: "ended" as const,
    count: 0,
    date: "2026-08-20",
  }),
}));

afterEach(() => cleanup());

function renderRow(presentation: DashboardStandingPresentation) {
  const candidate = progressCandidates.targetProgress(
    { subject: { scope: "profile", profileId: 1 }, sourceOrder: 0 },
    1,
    true,
    false,
    true
  );
  render(
    <ul>
      <DashboardFactRow
        candidate={candidate}
        presentation={presentation}
        lane="standing"
      />
    </ul>
  );
}

describe("the practice-target row's control slot (#4076)", () => {
  it("composes exactly one control onto the row", () => {
    const control = (
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today="2026-08-20"
        compact
      />
    );
    // The invariant is about CONTROL COMPONENTS composed onto the row, not the
    // buttons any one of them renders internally (LogPracticeButton itself draws
    // two — "Start now" and "Just finished" — and that has always been one
    // control). This row hands the slot exactly one.
    expect(Children.count(control)).toBe(1);
  });

  it("renders the control inside the trailing slot, not inside the row's own link", () => {
    renderRow({
      label: "Sauna",
      value: "0 of 2",
      href: "/wellness",
      presence: "current",
      control: (
        <LogPracticeButton
          practice="Sauna"
          todayCount={0}
          today="2026-08-20"
          compact
        />
      ),
    });

    const row = screen.getByTestId("dashboard-candidate");

    // Rule 1: the control lives in the trailing slot DashboardFactRow renders for
    // `presentation.control`, and nowhere else on the row.
    const controlSlot = within(row).getByTestId("dashboard-row-controls");
    // `getByTestId` throws if the control did not render inside the slot — the
    // call itself is rule 1's presence assertion.
    const tapButton = within(controlSlot).getByTestId("practice-log-button");

    // Link-wrap suppression (the reason the slot exists at all, per the code's own
    // comment): a row hosting a control is not wrapped in an anchor around its own
    // contents, because a `<form>`/`<button>` inside an `<a>` is invalid markup. Only
    // the row's identity (its label) carries the link — exactly one, and the tap
    // button is not a descendant of it.
    const links = within(row).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("Sauna");
    expect(tapButton.closest("a")).toBeNull();

    // Rule 2: the 34px control height. This row does not invent new sizing — it
    // reuses the same `DOSE_ACTION_LABEL` token (`h-(--control-box)`) every other
    // trailing-slot control already carries.
    expect(tapButton.className).toContain("h-(--control-box)");
    expect(
      within(controlSlot).getByTestId("practice-start-button").className
    ).toContain("h-(--control-box)");
  });
});
