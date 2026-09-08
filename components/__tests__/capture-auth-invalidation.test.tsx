import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfflineQueueProvider from "@/components/OfflineQueueProvider";
import {
  useWritePipeline,
  type WriteSpec,
} from "@/components/useWritePipeline";
import { LoggedViaSurface } from "@/components/LoggedViaSurface";
import {
  ProfileDaysBoundary,
  type LiveProfileClock,
} from "@/components/DayContext";
import type { StampedFormData } from "@/lib/logged-via";
import type { QueuedIntent } from "@/lib/offline/queue";
import {
  bumpGeneration,
  closeSession,
  defaultGate,
  gateWriteOutcome,
  openSessionAs,
  type WriteGate,
} from "@/lib/offline/write-gate";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  enqueueIntent: vi.fn(),
  captureWriteToken: vi.fn(),
  intents: [] as QueuedIntent[],
}));

let gate: WriteGate;

vi.mock("@/components/Toast", () => ({ useToast: () => mocks.toast }));
vi.mock("@/components/DirtyFormRegistry", () => ({
  useChromeRefresh: () => vi.fn(),
}));
vi.mock(import("@/lib/offline/write-gate"), async (importOriginal) => ({
  ...(await importOriginal()),
  captureWriteToken: mocks.captureWriteToken,
  openSessionForDocument: vi.fn(),
}));
vi.mock("@/lib/offline/queue-db", () => ({
  enqueueIntent: mocks.enqueueIntent,
  allIntents: vi.fn(async () => []),
  removeIntents: vi.fn(async () => undefined),
  putIntents: vi.fn(async () => undefined),
  saveRejected: vi.fn(async () => undefined),
  enqueueIntents: vi.fn(async () => "kept"),
  allRejected: vi.fn(async () => []),
  removeRejected: vi.fn(async () => undefined),
  countIntents: vi.fn(async () => mocks.intents.length),
}));

type Reply = { ok: true };

function Tap({
  action,
  onResult,
}: {
  action: (fd: StampedFormData) => Promise<Reply>;
  onResult: (result: string) => void;
}) {
  const pipeline = useWritePipeline("dose-status");
  const write = {
    fields: { dose_id: "7" },
    action,
    settle: () => ({
      wrote: true,
      announce: { message: "logged", undo: null },
    }),
    failureMessage: "failed",
    offline: (tappedAt: Date) => ({
      kind: "capture" as const,
      flow: "dose" as const,
      date: "2026-09-03",
      payload: { doseId: 7, clientTakenAt: tappedAt.toISOString() },
      keptMessage: "queued",
    }),
  } satisfies WriteSpec<"dose-status", Reply>;
  return (
    <button onClick={() => void pipeline.run(write).then(onResult)}>tap</button>
  );
}

async function beginPending() {
  let reject!: (reason: unknown) => void;
  const action = vi.fn(
    async () =>
      new Promise<Reply>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      })
  );
  let finish!: (result: string) => void;
  const done = new Promise<string>((resolve) => (finish = resolve));
  const clocks: ReadonlyMap<number, LiveProfileClock> = new Map([
    [1, { today: "2026-09-03", timeZone: "UTC" }],
  ]);
  render(
    <ProfileDaysBoundary clocks={clocks}>
      <OfflineQueueProvider activeProfileId={1} deviceSessionKey="session-a">
        <LoggedViaSurface value="quick-log">
          <Tap action={action} onResult={finish} />
        </LoggedViaSurface>
      </OfflineQueueProvider>
    </ProfileDaysBoundary>
  );
  await act(async () => {
    screen.getByRole("button", { name: "tap" }).click();
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
  return {
    reject,
    settle: async () => {
      await act(async () => reject(new TypeError("Failed to fetch")));
      return done;
    },
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.intents.length = 0;
  gate = openSessionAs("session-a")(defaultGate());
  mocks.captureWriteToken.mockImplementation(async () =>
    gate.sessionClosed ? -1 : gate.generation
  );
  mocks.enqueueIntent.mockImplementation(
    async (intent: QueuedIntent, token: number) => {
      const outcome = gateWriteOutcome(gate, "queue", token);
      if (outcome === "kept") mocks.intents.push(intent);
      return outcome;
    }
  );
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-03T23:59:00.000Z"));
});

afterEach(() => vi.useRealTimers());

describe("a pending captured attempt across identity invalidation", () => {
  it("does not reintroduce the old profile after a profile-switch fence", async () => {
    const pending = await beginPending();
    gate = bumpGeneration(gate);

    expect(await pending.settle()).toBe("nothing");
    expect(mocks.intents).toHaveLength(0);
  });

  it("does not reintroduce the old session after logout and a new login", async () => {
    const pending = await beginPending();
    gate = openSessionAs("session-b")(closeSession(gate));

    expect(await pending.settle()).toBe("nothing");
    expect(mocks.intents).toHaveLength(0);
  });

  it("a still-closed logout refuses the late enqueue", async () => {
    const pending = await beginPending();
    gate = closeSession(gate);

    expect(await pending.settle()).toBe("nothing");
    expect(mocks.intents).toHaveLength(0);
  });

  it("an ordinary same-session day rollover keeps the original intent", async () => {
    const pending = await beginPending();
    vi.setSystemTime(new Date("2026-09-04T00:01:00.000Z"));

    expect(await pending.settle()).toBe("captured");
    expect(mocks.intents).toHaveLength(1);
    expect(mocks.intents[0]).toMatchObject({
      profileId: 1,
      date: "2026-09-03",
      capturedAt: "2026-09-03T23:59:00.000Z",
      dayContext: {
        parts: { profileId: 1, day: "2026-09-03" },
        isPrimaryDay: true,
      },
    });
  });

  it("does not revive a capture that began while the session was closed", async () => {
    gate = closeSession(gate);
    const pending = await beginPending();
    gate = openSessionAs("session-b")(gate);

    expect(await pending.settle()).toBe("nothing");
    expect(mocks.intents).toHaveLength(0);
  });
});
