import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ScheduledDoseAction from "@/components/medications/ScheduledDoseAction";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";

// THE SHARED TIME STATEMENT'S RULES, PINNED ONCE (#4426). Four domains spelled this
// question by hand and each carried its own answer to "what happens to the statement
// when the tap lands"; the rules live in `useTimeStatement` now, so they are proven
// here rather than four times over.
//
// Driven through two REAL mounts rather than a harness component, because the rules
// that matter are about what a mount POSTS: a fixture that renders the hook alone
// could satisfy every assertion below while no surface passed `shown` or spent
// anything.

const { setDoseStatus, logPractice, enqueue, logMedicationAdministration } =
  vi.hoisted(() => ({
    setDoseStatus: vi.fn(),
    logPractice: vi.fn(),
    enqueue: vi.fn(),
    logMedicationAdministration: vi.fn(),
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
vi.mock("@/app/(app)/medications/actions", () => ({
  logMedicationAdministration,
}));
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

// RULE 4 — the reveal is a LABELLED statement (#4384 fix 3). Asserted over every mount
// this file already drives, because the defect was not "the practice row forgot a
// label": it was that the shared reveal had none to forget, so each of these opened
// onto an empty box between the word "Today" and a ghost "Now".
//
// The claim is the ASSOCIATION, not the presence of some text. A rendered `<label>` that
// points at nothing looks identical on screen and is worth nothing to the control, so
// each case resolves the label THROUGH the input's own `id` and then checks that the
// label is a real element rather than the `aria-label` this used to be.
describe("rule 4: opening the statement labels its control, visibly", () => {
  it.each([
    ["a scheduled dose", scheduledDose, "scheduled-dose-when"],
    [
      "the practice row",
      () =>
        render(
          <LogPracticeButton
            practice="Sauna"
            todayCount={0}
            today="2026-07-08"
            inlineWhen
          />
        ),
      "practice-when",
    ],
  ])("%s", (_label, mount, testId) => {
    mount();
    fireEvent.click(screen.getByTestId(`${testId}-toggle`));
    const time = screen.getByTestId(`${testId}-time`);
    const label = document.querySelector(`label[for="${time.id}"]`);
    expect(
      label,
      "the revealed control has no label element pointing at it"
    ).not.toBeNull();
    expect(label?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // …and it is the SAME name the control carries, so the visible words and the
    // accessible name cannot drift into two different answers.
    expect(label?.textContent?.trim()).toBe(time.getAttribute("aria-label"));
  });

  // THE CONVERSE, and it is the direction that rots: a label is only worth rendering
  // where a control exists to point at. A closed statement renders neither.
  it("renders no label while the statement is closed", () => {
    render(
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today="2026-07-08"
        inlineWhen
      />
    );
    expect(screen.queryByTestId("practice-when-time")).toBeNull();
    expect(
      document.querySelector('label[for="practice-when-time"]')
    ).toBeNull();
  });
});

describe("rule 5: a statement is spent by the tap it answers, and only that tap", () => {
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

// THE FOURTH DIALECT, CONVERGED (#4738 ruling 3). The PRN row's "Earlier dose" was the
// one statement that stated a DAY as well as a time, through a day picker of its own;
// the ruling put the day back on the surface and left this the time half. What that
// buys is asserted here rather than assumed: the row now obeys the shared rule 4 it
// never had, having previously cleared the field on ANY successful tap.
describe("the PRN row spends its statement on the tap that paid for it (#4426)", () => {
  function prnRow() {
    return render(
      <QuickLogPrnControl
        itemId={5}
        name="Ibuprofen"
        doseAmount="200 mg"
        dayLabel="none today"
        tz="UTC"
      />
    );
  }
  const timeField = () =>
    screen.getByTestId("prn-log-when-time") as HTMLInputElement;
  const lastPost = () =>
    logMedicationAdministration.mock.calls.at(-1)?.[0] as FormData;

  it("keeps a statement the now-tap never consumed, and spends the one Save dose does", async () => {
    logMedicationAdministration.mockResolvedValue({
      ok: true,
      outcome: "logged",
    });
    prnRow();
    fireEvent.click(screen.getByTestId("prn-log-more"));
    fireEvent.change(timeField(), { target: { value: "07:05" } });
    // THE FIXTURE REACHES THE STATE THE VERDICT IS ABOUT. Every assertion below is
    // about what happens to a statement that EXISTS, and all of them would pass over a
    // row that never accepted one.
    expect(timeField().value).toBe("07:05");

    await act(async () => {
      fireEvent.click(screen.getByTestId("prn-log-now"));
    });
    // The now-tap asserts an administration at the tap — no time on the post, so
    // nothing was paid for and the statement stands, still on screen.
    expect(lastPost().get("offset")).toBe("now");
    expect(lastPost().get("time")).toBeNull();
    expect(timeField().value).toBe("07:05");

    await act(async () => {
      fireEvent.click(screen.getByTestId("prn-log-custom"));
    });
    expect(lastPost().get("offset")).toBe("custom");
    expect(lastPost().get("time")).toBe("07:05");
    // …and THAT tap spent it. The reveal closes with the statement it consumed, and
    // reopening offers an empty field rather than a minute that would silently correct
    // the row the tap just wrote.
    expect(screen.queryByTestId("prn-log-when-time")).toBeNull();
    fireEvent.click(screen.getByTestId("prn-log-more"));
    expect(timeField().value).toBe("");
  });
});
