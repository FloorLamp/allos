import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LogPracticeButton from "@/components/practices/LogPracticeButton";

const ledger = vi.hoisted(() => ({ blocked: false }));
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  start: vi.fn(),
  end: vi.fn(),
  serverRead: vi.fn(),
}));

vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => mocks.confirm,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/LoggedViaSurface", () => ({
  // Hands the FormData back, as the real hook does and as every sibling mock here
  // spells it — a stamp that returns nothing modelled a control that discards it,
  // which is the shape #5349 made uncompilable.
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice: vi.fn(),
  startPracticeLive: mocks.start,
  endPracticeLive: mocks.end,
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    affordance: "practice-session",
    blocked: () => ledger.blocked,
    pending: () => false,
    tap: vi.fn(),
  }),
}));

describe("practice one-tap cooldown (#4491)", () => {
  beforeEach(() => {
    ledger.blocked = false;
    mocks.confirm.mockReset();
    mocks.start.mockReset();
    mocks.end.mockReset();
    mocks.serverRead.mockReset();
  });

  it("exposes the existing cooldown by disabling the one-tap control", () => {
    ledger.blocked = true;
    render(
      <LogPracticeButton practice="Sauna" todayCount={1} today="2026-08-31" />
    );

    expect(
      (screen.getByTestId("practice-log-button") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("keeps the control available when the shared ledger is ready", () => {
    render(
      <LogPracticeButton practice="Sauna" todayCount={1} today="2026-08-31" />
    );

    expect(
      (screen.getByTestId("practice-log-button") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("offers both quick intents until the practice is running", () => {
    const { rerender } = render(
      <LogPracticeButton practice="Sauna" todayCount={0} today="2026-08-31" />
    );

    expect(screen.getByRole("button", { name: /start a sauna/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /just finished a sauna/i })
    ).toBeTruthy();

    rerender(
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today="2026-08-31"
        inlineDuration
        liveSession={{
          id: 7,
          date: "2026-08-31",
          startTime: "09:15",
          expectedEnd: null,
        }}
      />
    );
    expect(
      screen.getByRole("button", { name: /end the running sauna/i })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /just finished a sauna/i })
    ).toBeNull();
    expect(screen.queryByTestId("practice-inline-duration")).toBeNull();
  });

  it("asks before ending the exact session returned by a stale Start now", async () => {
    mocks.start.mockResolvedValue({
      kind: "already-live",
      session: {
        id: 37,
        date: "2026-08-31",
        startTime: "09:15",
        expectedEnd: null,
      },
    });
    mocks.confirm.mockResolvedValue(true);
    mocks.end.mockResolvedValue({
      kind: "ended",
      session: {},
      count: 1,
      date: "2026-08-31",
    });
    render(
      <LogPracticeButton practice="Sauna" todayCount={0} today="2026-08-31" />
    );

    fireEvent.click(screen.getByTestId("practice-start-button"));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.end).toHaveBeenCalledTimes(1));
    const fd = mocks.end.mock.calls[0][0] as FormData;
    expect(fd.get("id")).toBe("37");
  });

  // A CANCELLED STALE START ASKS THE SERVER RATHER THAN ADOPTING ITS ANSWER (#5431).
  // This control used to keep a client copy of the session and set it here, which is
  // the same copy that let an `End` outlive a row the server had already completed.
  // The guarantee is unchanged — the row shows End afterwards — but it now arrives
  // through the read: the typed refusal asks for one, the row itself writes nothing,
  // and the session it renders is the one the read hands back.
  it("re-reads rather than adopting the session a stale Start now returned", async () => {
    mocks.start.mockResolvedValue({
      kind: "already-live",
      session: {
        id: 41,
        date: "2026-08-31",
        startTime: "09:15",
        expectedEnd: null,
      },
    });
    mocks.confirm.mockResolvedValue(false);
    const { rerender } = render(
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today="2026-08-31"
        onServerRead={mocks.serverRead}
      />
    );

    fireEvent.click(screen.getByTestId("practice-start-button"));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.end).not.toHaveBeenCalled();
    expect(mocks.serverRead).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("practice-end-button")).toBeNull();

    rerender(
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today="2026-08-31"
        onServerRead={mocks.serverRead}
        liveSession={{
          id: 41,
          date: "2026-08-31",
          startTime: "09:15",
          expectedEnd: null,
        }}
      />
    );
    expect(screen.getByTestId("practice-end-button")).toBeTruthy();
  });
});
