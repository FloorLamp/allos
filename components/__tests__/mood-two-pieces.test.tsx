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

const posted: Record<string, FormData[]> = {};
const record = (name: string, fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

type MoodReply = { ok: true } | { ok: false; error: string };
let logMoodReply: (fd: FormData) => Promise<MoodReply> = async () => ({
  ok: true,
});
let enqueueReply: "kept" | "closed" | "failed" = "kept";
const queued: {
  flow: string;
  date: string;
  payload: Record<string, unknown>;
}[] = [];
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
    enqueue: async (
      flow: string,
      date: string,
      payload: Record<string, unknown>
    ) => {
      queued.push({ flow, date, payload });
      return enqueueReply;
    },
  }),
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
      from?: number | null;
      optimistic: number;
      commit: (value: number | null) => void;
      write: () => Promise<unknown>;
      settle: (value: unknown) => { kind: string };
      onError?: (error: unknown) => Promise<{ kind: string } | undefined>;
    }) => {
      spec.commit(spec.optimistic);
      try {
        const settlement = spec.settle(await spec.write());
        if (settlement.kind === "rollback") spec.commit(spec.from ?? null);
      } catch (error) {
        const settlement = await spec.onError?.(error);
        if (settlement?.kind !== "keep") spec.commit(spec.from ?? null);
      }
    },
  }),
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
  queued.length = 0;
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
    "rolls back and stays open when offline capture is %s",
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
      ).toBe("false");
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

  // THE COLD OFFLINE OPEN'S CHECK-IN CARRIES WHAT ITS FORM COULD SEE (#3416). The
  // quick logger builds these days from the device's own queue when the gather fails,
  // so a day the person filled in elsewhere shows as empty here — and the write must
  // not read that emptiness as an answer. Both paths say so, because either can be
  // the one that runs: the queue when the connection is still down, and logMood when
  // it came back between the open and the tap.
  it("a form whose days could not be read says so on both write paths", async () => {
    render(<MoodForm days={[EMPTY]} showCalm={false} dayUnseen />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    expect(Object.fromEntries(posted.logMood[0])).toMatchObject({
      valence: "4",
      day_unseen: "1",
    });

    cleanup();
    logMoodReply = async () => {
      throw new TypeError("Failed to fetch");
    };
    render(<MoodForm days={[EMPTY]} showCalm={false} dayUnseen />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ valence: 4, dayUnseen: true });
  });

  // The control: an ordinary mount pre-fills from the stored check-in, so neither
  // path claims the day was unseen and the write keeps replacing the row.
  it("an ordinary mount claims nothing about what it could not see", async () => {
    render(<MoodForm days={[EMPTY]} showCalm={false} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    expect(Object.fromEntries(posted.logMood[0])).not.toHaveProperty(
      "day_unseen"
    );

    cleanup();
    logMoodReply = async () => {
      throw new TypeError("Failed to fetch");
    };
    render(<MoodForm days={[EMPTY]} showCalm={false} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    expect(queued[0].payload).not.toHaveProperty("dayUnseen");
  });

  // THE OTHER HALF OF THE ANNOUNCEMENT (#3416). The quick sheet remounts this form
  // when the day it could not see arrives, and says so only when the mount was
  // holding something. This form is what answers that question, so it has to answer
  // honestly: something typed is staged, the same field put back is not, and a mount
  // that goes leaves nothing to lose.
  it("says whether it is holding input a replacement would discard", async () => {
    const staged: boolean[] = [];
    const { unmount } = render(
      <MoodForm
        days={[LOGGED]}
        showCalm={false}
        onStagedChange={(value) => staged.push(value)}
      />
    );
    expect(staged.at(-1)).toBe(false);

    const note = screen.getByLabelText("Note");
    fireEvent.change(note, { target: { value: "long day, and a headache" } });
    expect(staged.at(-1)).toBe(true);

    // Typed back to what the day already said: nothing to discard, nothing to say.
    fireEvent.change(note, { target: { value: "long day" } });
    expect(staged.at(-1)).toBe(false);

    fireEvent.change(note, { target: { value: "long day, and a headache" } });
    expect(staged.at(-1)).toBe(true);
    unmount();
    expect(staged.at(-1)).toBe(false);
  });

  // AND IT DOES NOT COUNT WHAT A WRITE HAS ALREADY TAKEN (#3416). In quick mode the
  // valence tap IS the write, and `draft()` puts the whole Details block into the
  // payload — so between the tap and the settle the note is staged AND in flight. The
  // sheet announcing a discard in that window told somebody their paragraph was thrown
  // away while the FormData carrying it was still open, and it lands: the blind
  // check-in merges rather than replaces. A write that FAILS gives the fields back,
  // and then there really is something to lose again.
  it("is not holding input a write in flight has already taken", async () => {
    let settle: (reply: MoodReply) => void = () => {};
    logMoodReply = () =>
      new Promise<MoodReply>((resolve) => {
        settle = resolve;
      });

    const staged: boolean[] = [];
    render(
      <MoodForm
        days={[EMPTY]}
        showCalm={false}
        onStagedChange={(value) => staged.push(value)}
      />
    );
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "woke at 4, could not get back to sleep" },
    });
    expect(staged.at(-1)).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));
    });
    expect(staged.at(-1)).toBe(false);
    // The note really is in the payload the tap opened — which is why there is nothing
    // to announce about it.
    expect(posted.logMood?.[0]?.get("note")).toBe(
      "woke at 4, could not get back to sleep"
    );

    await act(async () => {
      settle({ ok: false, error: "Couldn't save that check-in." });
    });
    expect(staged.at(-1)).toBe(true);
  });

  it("names a single past-day quick tap from its actual date context", async () => {
    render(
      <MoodForm
        days={[{ date: "2026-08-19", label: "Aug 19", mood: null }]}
        showCalm={false}
      />
    );

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );

    expect(toasts).toContain("Logged Good · Aug 19");
    expect(toasts.join(" ")).not.toContain("Today");
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

  it("freezes the whole dated statement until a delayed write rolls back", async () => {
    let rejectWrite!: () => void;
    enqueueReply = "closed";
    logMoodReply = () =>
      new Promise((_resolve, reject) => {
        rejectWrite = () => reject(new TypeError("Failed to fetch"));
      });
    render(<MoodForm days={[EMPTY, LOGGED]} showCalm />);
    fireEvent.click(screen.getByText("Details"));
    fireEvent.click(screen.getByRole("button", { name: "Energy: 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }));

    const otherDay = screen.getByTestId("quick-mood-day-1");
    const energy5 = screen.getByRole("button", { name: "Energy: 5" });
    const calm5 = screen.getByRole("button", { name: "Calm: 5" });
    const work = screen.getByRole("button", { name: "Work" });
    const note = screen.getByLabelText("Note") as HTMLTextAreaElement;
    for (const control of [otherDay, energy5, calm5, work, note]) {
      expect(control.matches(":disabled")).toBe(true);
    }
    otherDay.click();
    energy5.click();
    calm5.click();
    work.click();
    note.focus();
    expect(document.activeElement).not.toBe(note);
    fireEvent.submit(screen.getByTestId("mood-form"));

    expect(posted.logMood).toHaveLength(1);
    expect(otherDay.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Energy: 3" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(energy5.getAttribute("aria-pressed")).toBe("false");
    expect(calm5.getAttribute("aria-pressed")).toBe("false");
    expect(work.getAttribute("aria-pressed")).toBe("false");
    expect(note.value).toBe("");

    rejectWrite();
    await waitFor(() =>
      expect(toasts).toContain(
        "This entry wasn't saved. Try again once you're back online."
      )
    );
    expect(
      screen
        .getByRole("button", { name: "Mood: Good" })
        .getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByTestId("quick-mood-day-0").getAttribute("aria-pressed")
    ).toBe("true");

    // Once A settles, B may load only B's stored statement. Saving it proves A's
    // rollback did not cross the date boundary or mix its detail state into B.
    fireEvent.click(otherDay);
    expect(
      screen
        .getByRole("button", { name: "Mood: Low" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Energy: 3" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Social" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(note.value).toBe("long day");
    logMoodReply = async () => ({ ok: true });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );

    expect(Object.fromEntries(posted.logMood[1])).toMatchObject({
      date: LOGGED.date,
      valence: "2",
      energy: "3",
      anxiety: "2",
      factors: "social",
      note: "long day",
    });
    expect(posted.logMood).toHaveLength(2);
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
