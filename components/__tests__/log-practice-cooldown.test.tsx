import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LogPracticeButton from "@/components/practices/LogPracticeButton";

const ledger = vi.hoisted(() => ({ blocked: false }));

vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => vi.fn(),
}));
vi.mock("@/app/(app)/wellness/actions", () => ({ logPractice: vi.fn() }));
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
});
