import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MoodForm, { type MoodFormDay } from "@/components/mood/MoodForm";
import MetricReadingsTable from "@/components/MetricReadingsTable";
import { DayContextProvider } from "@/components/DayContext";
import { SHEET_REACH } from "@/lib/log-manifest";

const posted: Record<string, FormData[]> = {};
const record = (name: string, fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

type MoodResult = { ok: true } | { ok: false; error: string };
let logMoodReply: (fd: FormData) => Promise<MoodResult> = async () => ({
  ok: true,
});
let enqueueReply: "kept" | "closed" | "failed" = "kept";
const enqueued: Array<{ flow: string; payload: unknown; capture: unknown }> =
  [];
const toasts: string[] = [];

vi.mock("@/app/(app)/mood-actions", () => ({
  logMood: async (fd: FormData) => {
    record("logMood", fd);
    return logMoodReply(fd);
  },
}));
vi.mock("@/app/(app)/trends/reading-actions", () => ({
  updateMetricReading: async (fd: FormData) => {
    record("updateMetricReading", fd);
    return { ok: true };
  },
  deleteMetricReading: async () => ({ undoId: 1 }),
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => (message: string) => toasts.push(message),
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({
    enqueue: async (flow: string, payload: unknown, capture: unknown) => {
      enqueued.push({ flow, payload, capture });
      return enqueueReply;
    },
  }),
  useQueuedDayContextCapture:
    () =>
    (date: string, reach: unknown, capturedAt = new Date()) => ({
      dayContext: {
        parts: { profileId: 1, day: date, reach },
        key: "test-context",
        isPrimaryDay: date === "2026-08-20",
      },
      capturedAt,
      writeToken: Promise.resolve(0),
    }),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
  useConfirmOpen: () => false,
}));
vi.mock("@/components/useUndoableDelete", () => ({
  useUndoableDelete: () => async () => {},
}));
const EMPTY: MoodFormDay = {
  date: "2026-08-20",
  label: "Today",
  mood: null,
};
const LOGGED: MoodFormDay = {
  date: "2026-08-19",
  label: "Yesterday",
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
  logMoodReply = async () => ({ ok: true });
  enqueueReply = "kept";
  enqueued.length = 0;
  toasts.length = 0;
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
    const energy = screen.getByRole("button", { name: "Energy: 1" });
    expect(energy.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(energy);
    expect(energy.getAttribute("aria-pressed")).toBe("true");
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
      <MoodForm
        days={[LOGGED]}
        showCalm
        subjectProfileId={42}
        mode="edit"
        onDone={done}
      />
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

  it.each(["closed", "failed"] as const)(
    "retains the draft and stays open when offline capture is %s",
    async (outcome) => {
      enqueueReply = outcome;
      logMoodReply = async () => {
        throw new TypeError("Failed to fetch");
      };
      const done = vi.fn();
      render(<MoodForm days={[EMPTY]} showCalm={false} onDone={done} />);

      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
      );

      expect(
        screen
          .getByRole("button", { name: "Mood: Good" })
          .getAttribute("aria-pressed")
      ).toBe("true");
      expect(toasts).toContain(
        "This entry wasn't saved. Try again once you're back online."
      );
      expect(screen.getByTestId("mood-form")).toBeTruthy();
      expect(done).not.toHaveBeenCalled();
    }
  );

  it("keeps an offline capture and completes only for the exact kept outcome", async () => {
    logMoodReply = async () => {
      throw new TypeError("Failed to fetch");
    };
    const done = vi.fn();
    render(<MoodForm days={[EMPTY]} showCalm={false} onDone={done} />);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );

    expect(
      screen
        .getByRole("button", { name: "Mood: Good" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(toasts).toContain("Saved offline — will sync when you reconnect.");
    expect(done).toHaveBeenCalledOnce();
  });

  it("accepts an intentional identical History entry after the form resets", async () => {
    const saved = vi.fn();
    const view = render(
      <MoodForm
        days={[EMPTY]}
        showCalm={false}
        repeatAfterSave
        onSaved={saved}
      />
    );

    fireEvent.click(screen.getByText("Details"));
    fireEvent.click(screen.getByRole("button", { name: "Energy: 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "the row just saved" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    view.rerender(
      <MoodForm
        days={[
          {
            ...EMPTY,
            mood: {
              valence: 4,
              energy: 3,
              anxiety: null,
              factors: ["work"],
              notes: "the row just saved",
            },
          },
        ]}
        showCalm={false}
        repeatAfterSave
        onSaved={saved}
      />
    );

    expect(
      screen
        .getByRole("button", { name: "Energy: 3" })
        .getAttribute("aria-pressed")
    ).toBe("false");
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      ""
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );

    expect(posted.logMood).toHaveLength(2);
    expect(Object.fromEntries(posted.logMood[1])).not.toHaveProperty("energy");
    expect(Object.fromEntries(posted.logMood[1])).not.toHaveProperty("note");
    expect(saved).toHaveBeenCalledTimes(2);
  });

  it("freezes the whole dated statement and retains it after a delayed refusal", async () => {
    let rejectWrite!: (error: unknown) => void;
    logMoodReply = () =>
      new Promise<{ ok: true }>((_, reject) => {
        rejectWrite = reject;
      });
    enqueueReply = "closed";
    render(
      <DayContextProvider
        profileId={1}
        today={EMPTY.date}
        reach={SHEET_REACH}
        backing={{ kind: "state", initialDay: EMPTY.date }}
      >
        <MoodForm days={[EMPTY]} showCalm />
      </DayContextProvider>
    );
    fireEvent.click(screen.getByText("Details"));
    fireEvent.click(screen.getByRole("button", { name: "Energy: 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Calm: 4" }));
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "keep this detail" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));

    await waitFor(() => expect(posted.logMood).toHaveLength(1));
    for (const control of [
      screen.getByRole("button", { name: "Mood: Great" }),
      screen.getByRole("button", { name: "Energy: 5" }),
      screen.getByRole("button", { name: "Calm: 5" }),
      screen.getByRole("button", { name: "Work" }),
      screen.getByLabelText("Note"),
    ]) {
      expect(control.matches(":disabled")).toBe(true);
    }
    fireEvent.submit(screen.getByTestId("mood-form"));
    expect(posted.logMood).toHaveLength(1);

    await act(async () => rejectWrite(new TypeError("Failed to fetch")));

    expect(
      screen
        .getByRole("button", { name: "Mood: Good" })
        .getAttribute("aria-pressed")
    ).toBe("true");
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
    expect(
      screen.getByRole("button", { name: "Work" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      "keep this detail"
    );
    expect(screen.getByTestId("mood-form")).toBeTruthy();
  });

  it.each(["returned", "thrown"] as const)(
    "keeps a blind attempt immutable through a %s failure, then retries completely",
    async (failure) => {
      let finishFirst!: () => void;
      logMoodReply = () =>
        new Promise<MoodResult>((resolve, reject) => {
          finishFirst = () => {
            if (failure === "returned")
              resolve({ ok: false, error: "Couldn't save that check-in." });
            else reject(new TypeError("Failed to fetch"));
          };
        });
      enqueueReply = "closed";
      const view = render(
        <MoodForm days={[EMPTY]} showCalm dayUnseen onDone={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Details"));
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));
      await waitFor(() => expect(posted.logMood).toHaveLength(1));

      const fresh: MoodFormDay = {
        ...EMPTY,
        mood: {
          valence: 2,
          energy: 3,
          anxiety: null,
          factors: [],
          notes: "new",
        },
      };
      view.rerender(<MoodForm days={[fresh]} showCalm dayUnseen={false} />);
      await waitFor(() =>
        expect(
          (screen.getByLabelText("Note") as HTMLTextAreaElement).value
        ).toBe("new")
      );
      expect(
        screen
          .getByRole("button", { name: "Mood: Good" })
          .getAttribute("aria-pressed")
      ).toBe("true");
      expect(
        screen
          .getByRole("button", { name: "Energy: 3" })
          .getAttribute("aria-pressed")
      ).toBe("true");

      await act(async () => finishFirst());
      expect(enqueued).toHaveLength(failure === "thrown" ? 1 : 0);
      if (failure === "thrown") {
        expect(enqueued[0].payload).toMatchObject({
          valence: 4,
          energy: null,
          note: null,
          dayUnseen: true,
        });
      }
      expect(Object.fromEntries(posted.logMood[0])).toMatchObject({
        date: EMPTY.date,
        valence: "4",
        day_unseen: "1",
      });
      expect(Object.fromEntries(posted.logMood[0])).not.toHaveProperty(
        "energy"
      );
      expect(Object.fromEntries(posted.logMood[0])).not.toHaveProperty("note");
      expect(screen.getByRole("alert").textContent).toContain(
        failure === "thrown" ? "wasn't saved" : "Couldn't save"
      );

      logMoodReply = async () => ({ ok: true });
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
      );
      const retry = Object.fromEntries(posted.logMood[1]);
      expect(retry).toMatchObject({
        date: EMPTY.date,
        valence: "4",
        energy: "3",
        note: "new",
      });
      expect(retry).not.toHaveProperty("day_unseen");
    }
  );

  it("finishes stale-attempt persistence without speaking into a replacement day", async () => {
    let rejectWrite!: (error: unknown) => void;
    logMoodReply = () =>
      new Promise<MoodResult>((_, reject) => {
        rejectWrite = reject;
      });
    const done = vi.fn();
    const view = render(
      <MoodForm days={[EMPTY]} showCalm={false} dayUnseen onDone={done} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));
    await waitFor(() => expect(posted.logMood).toHaveLength(1));

    const replacement: MoodFormDay = {
      date: "2026-08-21",
      label: "Today",
      mood: {
        valence: 2,
        energy: 3,
        anxiety: null,
        factors: [],
        notes: "replacement",
      },
    };
    view.rerender(
      <MoodForm
        days={[replacement]}
        showCalm={false}
        dayUnseen={false}
        onDone={done}
      />
    );
    await act(async () => rejectWrite(new TypeError("Failed to fetch")));

    await waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued[0]).toMatchObject({
      flow: "mood",
      payload: { valence: 4, dayUnseen: true },
      capture: { dayContext: { parts: { day: EMPTY.date } } },
    });
    expect(done).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(screen.getByTestId("mood-form").getAttribute("aria-busy")).toBe(
      "false"
    );
    expect(
      screen
        .getByRole("button", { name: "Mood: Low" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain(
      "no longer available"
    );
  });

  it("suppresses a stale server success after the offered day is replaced", async () => {
    let resolveWrite!: (result: MoodResult) => void;
    logMoodReply = () =>
      new Promise<MoodResult>((resolve) => {
        resolveWrite = resolve;
      });
    const done = vi.fn();
    const view = render(
      <MoodForm days={[EMPTY]} showCalm={false} onDone={done} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));
    await waitFor(() => expect(posted.logMood).toHaveLength(1));

    const replacement: MoodFormDay = {
      date: "2026-08-21",
      label: "Today",
      mood: {
        valence: 2,
        energy: null,
        anxiety: null,
        factors: [],
        notes: null,
      },
    };
    view.rerender(
      <MoodForm days={[replacement]} showCalm={false} onDone={done} />
    );
    await act(async () => resolveWrite({ ok: true }));

    expect(done).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(screen.getByTestId("mood-form").getAttribute("aria-busy")).toBe(
      "false"
    );
    expect(
      screen
        .getByRole("button", { name: "Mood: Low" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("lets a pending attempt reach the existing queue gate after unmount without stale presentation", async () => {
    let rejectWrite!: (error: unknown) => void;
    logMoodReply = () =>
      new Promise<MoodResult>((_, reject) => {
        rejectWrite = reject;
      });
    enqueueReply = "closed";
    const done = vi.fn();
    const view = render(
      <MoodForm days={[EMPTY]} showCalm={false} dayUnseen onDone={done} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));
    await waitFor(() => expect(posted.logMood).toHaveLength(1));

    view.unmount();
    await act(async () => rejectWrite(new TypeError("Failed to fetch")));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      flow: "mood",
      payload: { valence: 4, dayUnseen: true },
    });
    expect(done).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  it("writes only the selected shared-context day without private day chips", async () => {
    render(
      <DayContextProvider
        profileId={1}
        today="2026-08-21"
        reach={SHEET_REACH}
        backing={{ kind: "state", initialDay: "2026-08-19" }}
      >
        <MoodForm
          days={[
            { date: "2026-08-21", label: "Today", mood: null },
            { date: "2026-08-19", label: "Aug 19", mood: null },
          ]}
          showCalm={false}
        />
      </DayContextProvider>
    );

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );

    expect(toasts).toContain("Logged Good · Aug 19");
    expect(Object.fromEntries(posted.logMood[0])).toMatchObject({
      date: "2026-08-19",
      valence: "4",
    });
    expect(screen.queryByTestId("quick-mood-day-1")).toBeNull();
  });

  it.each(["rating-first", "details-first"] as const)(
    "posts one complete edit when changed in %s order",
    async (order) => {
      const chooseRating = () =>
        fireEvent.click(screen.getByRole("button", { name: "Mood: Great" }));
      const chooseDetails = () => {
        fireEvent.click(screen.getByRole("button", { name: "Energy: 4" }));
        fireEvent.click(screen.getByRole("button", { name: "Work" }));
        fireEvent.change(screen.getByLabelText("Note"), {
          target: { value: "  recovered  " },
        });
      };
      render(
        <MoodForm days={[LOGGED]} showCalm subjectProfileId={42} mode="edit" />
      );
      fireEvent.click(screen.getByText("Details"));
      if (order === "rating-first") {
        chooseRating();
        chooseDetails();
      } else {
        chooseDetails();
        chooseRating();
      }
      expect(posted.logMood).toBeUndefined();

      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
      );

      expect(posted.logMood).toHaveLength(1);
      expect(Object.fromEntries(posted.logMood[0])).toMatchObject({
        profile_id: "42",
        date: LOGGED.date,
        valence: "5",
        energy: "4",
        anxiety: "2",
        factors: "work",
        note: "recovered",
      });
    }
  );

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
    fireEvent.click(screen.getByRole("button", { name: /Reading actions/ }));
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
