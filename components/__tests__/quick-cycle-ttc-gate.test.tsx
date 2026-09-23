import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickCyclePanel from "@/components/quick-entry/QuickCyclePanel";
import type { QuickEntryTtc } from "@/app/(app)/quick-entry-actions";
import { cycleControlState } from "@/lib/cycle-plausibility";

// #5810 — THE GATE IS THE FEATURE, and this is the tier that can say so.
//
// The quick-log sheet's cycle overlay grew a second half: the three daily TTC
// observations, mounted from the SAME <TtcLogControls> the Cycle page renders. No
// profile on prod has declared a TTC start, so for everyone the change has to be
// nothing at all — not "nearly nothing", not "a hidden div", nothing.
//
// The server half of that claim lives in the action tier (the gathered payload for an
// undeclared profile is deep-equal to the two fields it always carried). What only this
// tier can ask is what the COMPONENT does when the field is absent, so the assertion is
// over the whole rendered subtree rather than over the absence of a test id: a leak that
// rendered an empty wrapper, a stray space or a changed class would pass a
// `queryByTestId(...) === null` check and fails this one.
//
// PANEL_MARKUP_BEFORE_5810 was captured by rendering this file's own case against
// QuickCyclePanel as it stood at the merge-base. It is a frozen artifact, not a
// convenience: if a later change means to alter what the sheet shows a non-TTC profile,
// it has to say so by editing this string.

const { toast, announce, motion, actions } = vi.hoisted(() => ({
  toast: vi.fn(),
  announce: vi.fn(),
  motion: { reduced: false },
  actions: {
    startPeriodAction: vi.fn(),
    endPeriodAction: vi.fn(),
    reopenPeriodAction: vi.fn(),
    undoEndPeriodAction: vi.fn(),
  },
}));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));
vi.mock("@/components/useUndoableAction", () => ({
  useUndoableAction: () => announce,
}));
vi.mock("@/components/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => motion.reduced,
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    // The ledger's one job this file leans on: run the write, hand its answer to
    // `settle`. Absorption and cooldown are the ledger's own suite's.
    tap: async ({
      write,
      settle,
    }: {
      write: () => Promise<unknown>;
      settle: (result: unknown) => unknown;
    }) => settle(await write()),
  }),
}));
// The two server-action modules the two halves post to. Importing them for real would
// drag the database in; the period offer's tap below answers through these stubs.
vi.mock("@/app/(app)/medical/cycles/actions", () => actions);
vi.mock("@/app/(app)/medical/cycles/ttc-actions", () => ({
  logLhTestAction: vi.fn(),
  logBbtAction: vi.fn(),
  logMucusAction: vi.fn(),
}));

// One state, resolved the way the server resolves it: no history, so the offer is the
// START verb and the panel is at its fullest ordinary shape.
const STATE = cycleControlState([], "2026-04-20", null);

const TTC: QuickEntryTtc = {
  todayLh: null,
  todayBbtF: null,
  todayMucus: null,
  temperatureUnit: "F",
};

const PANEL_MARKUP_BEFORE_5810 =
  '<div class="space-y-3" data-testid="quick-cycle-panel"><div class="text-sm text-slate-600 dark:text-slate-300">No periods logged yet — recording day 1 is what the cycle day and phase are derived from.</div><div class="space-y-2" data-testid="period-offer-sheet"><button type="button" data-testid="period-started-button" data-button-control="" class="button-control button-control-primary w-full" data-period-write="start">Period started today</button></div></div>';

afterEach(cleanup);

const panel = (ttc?: QuickEntryTtc) =>
  render(<QuickCyclePanel state={STATE} ttc={ttc} onDone={() => {}} />)
    .container.innerHTML;

describe("the sheet's cycle overlay is unchanged for a profile that has not declared TTC (#5810)", () => {
  it("renders byte-identical markup when the gathered payload carries no `ttc`", () => {
    expect(panel()).toBe(PANEL_MARKUP_BEFORE_5810);
  });

  it("mounts the three observation controls only when it does", () => {
    expect(screen.queryByTestId("ttc-log-bar")).toBeNull();
    cleanup();
    panel(TTC);
    expect(screen.getByTestId("ttc-log-bar")).toBeTruthy();
    for (const id of [
      "ttc-lh-positive",
      "ttc-lh-negative",
      "ttc-mucus-egg_white",
      "ttc-bbt-input",
      "ttc-bbt-save",
    ]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    // The period offer keeps its place ABOVE them: the row's own verb is still the
    // row's own verb (#1892), and the three taps are what a TTC morning adds to it.
    const html = document.body.innerHTML;
    expect(html.indexOf("period-started-button")).toBeLessThan(
      html.indexOf("ttc-log-bar")
    );
  });
});

// #5900 B and #5663 ruling 1, at the tier that can see them: one settle after a landed
// write and none otherwise, and the end's toast carrying an Undo that names its row.
describe("the period offer after a tap", () => {
  const OPEN = cycleControlState(
    [
      {
        id: 7,
        period_start: "2026-04-18",
        period_end: null,
        flow: null,
        note: null,
      },
    ],
    "2026-04-20",
    null
  );
  const wrapper = () => screen.getByTestId("period-offer-sheet");

  beforeEach(() => {
    motion.reduced = false;
    announce.mockReset();
    actions.endPeriodAction.mockReset();
    actions.undoEndPeriodAction.mockReset();
  });

  it("settles once after an end that landed, and its toast offers the Undo", async () => {
    actions.endPeriodAction.mockResolvedValue({
      ok: true,
      id: 7,
      end: "2026-04-20",
    });
    actions.undoEndPeriodAction.mockResolvedValue({ ok: true });
    render(<QuickCyclePanel state={OPEN} onDone={() => {}} />);
    await act(async () =>
      fireEvent.click(screen.getByTestId("period-ended-button"))
    );

    expect(wrapper().className).toContain("motion-settle");
    await waitFor(() =>
      expect(wrapper().className).not.toContain("motion-settle")
    );

    expect(announce).toHaveBeenCalledOnce();
    const { message, undo } = announce.mock.calls[0][0];
    expect(message).toBe("Period end logged · today");
    expect(await undo.run()).toEqual({ ok: true });
    const posted = actions.undoEndPeriodAction.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(posted)).toEqual({ id: "7", end: "2026-04-20" });
  });

  it("does not settle or announce on a refusal", async () => {
    actions.endPeriodAction.mockResolvedValue({
      ok: false,
      error: "Couldn't end the period. No period is open.",
    });
    render(<QuickCyclePanel state={OPEN} onDone={() => {}} />);
    await act(async () =>
      fireEvent.click(screen.getByTestId("period-ended-button"))
    );

    expect(wrapper().className).not.toContain("motion-settle");
    expect(announce).not.toHaveBeenCalled();
    expect(screen.getByText(/No period is open/)).toBeTruthy();
  });

  it("does not settle under reduced motion, and a start offers no Undo", async () => {
    motion.reduced = true;
    actions.startPeriodAction.mockResolvedValue({ ok: true });
    render(<QuickCyclePanel state={STATE} onDone={() => {}} />);
    await act(async () =>
      fireEvent.click(screen.getByTestId("period-started-button"))
    );

    expect(wrapper().className).not.toContain("motion-settle");
    expect(announce).toHaveBeenCalledWith({
      message: "Period start logged · today",
      undo: null,
    });
  });
});
