import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MoodForm, { type MoodFormDay } from "@/components/mood/MoodForm";
import MetricReadingsTable from "@/components/MetricReadingsTable";

const posted: Record<string, FormData[]> = {};
const record = (name: string, fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

vi.mock("@/app/(app)/mood-actions", () => ({
  logMood: async (fd: FormData) => {
    record("logMood", fd);
    return { ok: true };
  },
}));
vi.mock("@/app/(app)/trends/reading-actions", () => ({
  updateMetricReading: async (fd: FormData) => {
    record("updateMetricReading", fd);
    return { ok: true };
  },
  deleteMetricReading: async () => ({ undoId: 1 }),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: async () => "kept" }),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
  useConfirmOpen: () => false,
}));
vi.mock("@/components/useUndoableDelete", () => ({
  useUndoableDelete: () => async () => {},
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    tap: async (spec: {
      optimistic: number;
      commit: (value: number) => void;
      write: () => Promise<unknown>;
      settle: (value: unknown) => unknown;
    }) => {
      spec.commit(spec.optimistic);
      spec.settle(await spec.write());
    },
  }),
}));

const EMPTY: MoodFormDay = { date: "2026-08-20", mood: null };
const LOGGED: MoodFormDay = {
  date: "2026-08-19",
  mood: {
    valence: 2,
    energy: 3,
    anxiety: 2,
    factors: ["social"],
    notes: "long day",
  },
};

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  cleanup();
});

describe("the mood domain's two pieces", () => {
  it("uses one full-statement form for a new check-in and an existing row", async () => {
    const done = vi.fn();
    render(<MoodForm days={[EMPTY]} showCalm={false} onDone={done} />);
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByRole("button", { name: "Energy: 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Work" })).toBeTruthy();
    expect(screen.getByLabelText("Note")).toBeTruthy();
    expect(screen.queryByText("Calm")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Energy: 4" }));
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "  focused  " },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    expect(Object.fromEntries(posted.logMood[0])).toMatchObject({
      date: EMPTY.date,
      valence: "4",
      energy: "4",
      factors: "work",
      note: "focused",
    });
    expect(done).toHaveBeenCalledOnce();

    cleanup();
    render(
      <MoodForm days={[LOGGED]} showCalm subjectProfileId={42} onDone={done} />
    );
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByRole("button", { name: "Work" })).toBeTruthy();
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      "long day"
    );
    expect(
      screen
        .getByRole("button", { name: "Energy: 3" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Calm: 4" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );
    expect(Object.fromEntries(posted.logMood[1])).toMatchObject({
      profile_id: "42",
      date: LOGGED.date,
      valence: "2",
      energy: "3",
      anxiety: "2",
      factors: "social",
      note: "long day",
    });
  });

  it("uses the existing shared reading control for one-rating corrections", async () => {
    render(
      <MetricReadingsTable
        kind="mood"
        rows={[
          {
            id: 7,
            date: "2026-08-20",
            target: "mood:7:valence",
            display: "2",
            editValue: 2,
            source: "manual",
            flag: null,
            edited: false,
            notes: null,
          },
        ]}
        unit="/5"
        weightUnit="kg"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reading actions for 2026-08-20" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Reading value"), {
      target: { value: "4" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );
    expect(Object.fromEntries(posted.updateMetricReading[0])).toMatchObject({
      kind: "mood",
      target: "mood:7:valence",
      value: "4",
    });
  });
});
