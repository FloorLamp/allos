import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickPracticeList from "@/components/quick-entry/QuickPracticeList";
import { ToastProvider } from "@/components/Toast";
import type { TrackedPractice } from "@/lib/queries/wellness";

// THE FIRST-PRACTICE DOOR (#3066). `/wellness`'s nav row is gated on practice state
// (#1620, correct for an empty ledger) and every other route onto practices —
// the Telegram nudges, the habits widget, the trends lens (the frequent-pages row
// was a fourth until #4102 retired it) —
// needs a practice to already exist. The quick-log sheet's "Log practice" row is
// always visible, so the bootstrap lives here: nothing tracked renders the create
// form, and it must NOT keep rendering it once a practice exists (a bootstrap, not a
// permanent second door onto Wellness's own editor).

const SAUNA: TrackedPractice = {
  targetId: 1,
  identity: "sauna",
  name: "Sauna",
  perWeek: 3,
  perWeekMax: null,
  countThisWeek: 1,
  todayCount: 0,
  pace: "on-pace",
  atCeiling: false,
  previousDurationMin: null,
  liveSession: null,
};

// The populated branch's row control drags in the offline queue + confirm providers.
// This test asks WHICH branch renders, not what the log button does, so it stands in
// for the real one (whose own behaviour is covered by the practice specs).
vi.mock("@/components/practices/LogPracticeButton", () => ({
  default: () => <button type="button">Log</button>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

// jsdom has no media-query engine, and the toast provider asks it about reduced
// motion the moment it mounts.
beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
});

afterEach(cleanup);

describe("the quick-log practice body", () => {
  it.each([
    { state: "nothing tracked", practices: [], create: true },
    { state: "one tracked practice", practices: [SAUNA], create: false },
  ])("$state -> create form rendered: $create", ({ practices, create }) => {
    render(
      <ToastProvider>
        <QuickPracticeList practices={practices} today="2026-08-27" />
      </ToastProvider>
    );
    expect(screen.queryByTestId("practice-create-form") != null).toBe(create);
    expect(screen.queryByTestId("quick-entry-practice-list") != null).toBe(
      !create
    );
  });
});
