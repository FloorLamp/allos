import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: vi.fn(),
  }),
}));
// The two server-action modules the two halves post to. Never called here — this file
// asks what is RENDERED — but importing them for real would drag the database in.
vi.mock("@/app/(app)/medical/cycles/actions", () => ({
  startPeriodAction: vi.fn(),
  endPeriodAction: vi.fn(),
  reopenPeriodAction: vi.fn(),
}));
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
  '<div class="space-y-3" data-testid="quick-cycle-panel"><div class="text-sm text-slate-600 dark:text-slate-300">No periods logged yet — recording day 1 is what the cycle day and phase are derived from.</div><div class="space-y-2" data-testid="period-offer-sheet"><button type="button" class="btn btn-sm w-full" data-testid="period-started-button" data-period-write="start">Period started today</button></div></div>';

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
