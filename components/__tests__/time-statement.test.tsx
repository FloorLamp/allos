import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ScheduledDoseAction from "@/components/medications/ScheduledDoseAction";
import LogPracticeButton from "@/components/practices/LogPracticeButton";

// THE SHARED TIME STATEMENT'S RULES, PINNED ONCE (#4426). Four domains spelled this
// question by hand and each carried its own answer to "what happens to the statement
// when the tap lands"; the rules live in `useTimeStatement` now, so they are proven
// here rather than four times over.
//
// Driven through two REAL mounts rather than a harness component, because the rules
// that matter are about what a mount POSTS: a fixture that renders the hook alone
// could satisfy every assertion below while no surface passed `shown` or spent
// anything.

const { setDoseStatus, logPractice, enqueue } = vi.hoisted(() => ({
  setDoseStatus: vi.fn(),
  logPractice: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue }),
}));
vi.mock("@/components/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => false,
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/useUndoableAction", () => ({
  useUndoableAction: () => vi.fn(),
}));
// The ledger stands in for the real one and RUNS the write, so a tap is not a no-op
// that would pass any assertion about what tapping does.
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: (affordance: string) => ({
    affordance,
    pending: () => false,
    blocked: () => false,
    tap: async <T,>(op: {
      write: () => Promise<T>;
      settle: (outcome: T) => unknown;
    }) => op.settle(await op.write()),
  }),
}));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({ setDoseStatus }));
vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice,
  startPracticeLive: vi.fn(),
  endPracticeLive: vi.fn(),
}));

function scheduledDose(
  props: Partial<{ taken: boolean; skipped: boolean }> = {}
) {
  return render(
    <ScheduledDoseAction
      doseId={7}
      doseLabel="50 mcg · Morning"
      taken={props.taken ?? false}
      skipped={props.skipped ?? false}
    />
  );
}

describe("a scheduled dose confirm can state when it was taken (#4426)", () => {
  it("posts the stated wall time, and nothing at all until one is stated", async () => {
    setDoseStatus.mockResolvedValue({ ok: true, outcome: "logged" });
    scheduledDose();

    // RULE 1 — closed and empty is the fast path. The field is absent from the body,
    // which is what tells the write core the administration is the tap.
    await act(async () => {
      fireEvent.click(screen.getByTestId("dose-take"));
    });
    expect(setDoseStatus.mock.calls.at(-1)?.[0].get("at")).toBeNull();

    fireEvent.click(screen.getByTestId("scheduled-dose-when-toggle"));
    fireEvent.change(screen.getByTestId("scheduled-dose-when-time"), {
      target: { value: "07:05" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("dose-take"));
    });
    expect(setDoseStatus.mock.calls.at(-1)?.[0].get("at")).toBe("07:05");
  });

  // RULE 2 — the statement is offered on an UNRESOLVED row and nowhere else, and
  // (proven above by the absent field) a surface that does not offer it posts no time.
  // Correcting a resolved row is the dose-history panel's audited door. The clear row
  // is in this table on purpose: without it, "no toggle" would be satisfied by a
  // control that never renders one.
  it.each([
    ["clear", {}, true],
    ["taken", { taken: true }, false],
    ["skipped", { skipped: true }, false],
  ])("a %s row offers the statement: %s", (_label, props, offered) => {
    scheduledDose(props);
    expect(screen.queryByTestId("scheduled-dose-when-toggle") !== null).toBe(
      offered
    );
  });

  it("does not state a time on a SKIP, which asserts no administration", async () => {
    setDoseStatus.mockResolvedValue({ ok: true, outcome: "skipped" });
    scheduledDose();

    fireEvent.click(screen.getByTestId("scheduled-dose-when-toggle"));
    fireEvent.change(screen.getByTestId("scheduled-dose-when-time"), {
      target: { value: "07:05" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("dose-skip"));
    });

    expect(setDoseStatus.mock.calls.at(-1)?.[0].get("at")).toBeNull();
  });
});

describe("rule 4: a statement is spent by the tap it answers, and only that tap", () => {
  // The practice sheet used to clear the field unconditionally on a landed log. The
  // settle runs arbitrarily LATER than the tap, so a statement made while the first
  // write was still in flight was wiped by a settle that never saw it — and the next
  // tap then posted no time at all. The shared rule compares against what the tap
  // CONSUMED, so anything newer survives.
  it("keeps a statement made while the previous write was still in flight", async () => {
    let land: ((outcome: unknown) => void) | null = null;
    logPractice.mockImplementation(
      () => new Promise((resolve) => (land = resolve))
    );
    render(
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today="2026-07-08"
        inlineWhen
      />
    );

    fireEvent.click(screen.getByTestId("practice-when-toggle"));
    const time = () =>
      screen.getByTestId("practice-when-time") as HTMLInputElement;
    fireEvent.change(time(), { target: { value: "07:05" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("practice-log-button"));
    });
    expect(logPractice.mock.calls.at(-1)?.[0].get("end_time")).toBe("07:05");

    // A second session, stated while the first request is still open.
    fireEvent.change(time(), { target: { value: "08:40" } });
    await act(async () => {
      land?.({ kind: "logged", date: "2026-07-08", count: 1 });
    });

    expect(time().value).toBe("08:40");
  });

  // A DELIBERATE CONVERSE GUARD, and it passes on the tree before this change too:
  // spending unconditionally also clears the field. It is here because the test above
  // it would otherwise be satisfied by a spend that never fires at all — one direction
  // of a rule is not the rule.
  it("drops the statement the landed tap actually consumed", async () => {
    logPractice.mockResolvedValue({
      kind: "logged",
      date: "2026-07-08",
      count: 1,
    });
    render(
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today="2026-07-08"
        inlineWhen
      />
    );

    fireEvent.click(screen.getByTestId("practice-when-toggle"));
    fireEvent.change(screen.getByTestId("practice-when-time"), {
      target: { value: "07:05" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("practice-log-button"));
    });

    // Restating the same minute would CORRECT the session the first tap wrote rather
    // than adding one, so the field cannot stay armed.
    expect(
      (screen.getByTestId("practice-when-time") as HTMLInputElement).value
    ).toBe("");
  });
});

describe("an offline dose confirm queues the stated administration (#4426)", () => {
  // THE CAPTURE CARRIES THE STATEMENT, NOT THE TAP. A queued confirm already carried
  // `clientTakenAt` so the replay would not claim the sync instant; with a statement on
  // screen the tap instant is simply the wrong fact, and replay re-validates whatever
  // is sent against the row's own day (`resolveQueuedTakenAt`). Without this the stated
  // minute was silently lost on exactly the taps most likely to be made away from
  // signal.
  it("sends the stated instant as clientTakenAt", async () => {
    enqueue.mockResolvedValue("kept");
    const online = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    try {
      scheduledDose();
      fireEvent.click(screen.getByTestId("scheduled-dose-when-toggle"));
      fireEvent.change(screen.getByTestId("scheduled-dose-when-time"), {
        target: { value: "07:05" },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("dose-take"));
      });

      const [flow, , payload] = enqueue.mock.calls.at(-1) ?? [];
      expect(flow).toBe("dose");
      // The zone is pinned to UTC by the mock above, so the stated wall time IS the
      // instant's UTC clock — a naive `${day}T07:05` string would read the same here
      // and differently in every other zone, which is why the assertion reads the
      // MINUTE off the instant rather than comparing a built string.
      const sent = new Date(
        (payload as { clientTakenAt: string }).clientTakenAt
      );
      expect(sent.getUTCHours()).toBe(7);
      expect(sent.getUTCMinutes()).toBe(5);
    } finally {
      if (online) Object.defineProperty(window.navigator, "onLine", online);
    }
  });
});
