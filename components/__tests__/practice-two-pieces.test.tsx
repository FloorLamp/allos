import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PracticeSessionForm from "@/components/practices/PracticeSessionForm";
import { shiftHHMM } from "@/lib/activity-meta";
import LogPracticeButton from "@/components/practices/LogPracticeButton";

// THE PRACTICE DOMAIN'S TWO PIECES (#4424, `LOG_MANIFEST.practice.pieces`).
//
// Each cell flips on a claim, and each is asserted as a RELATIONSHIP rather than as a
// rendered literal — a literal goes stale the day the copy moves and says nothing about
// the property:
//
//   • ONE FORM for add and full-statement edit — asserted at the SEAM (same component,
//     same field set, differing only in seed and action), which is the shape four
//     spellings of these same five fields could never have;
//   • the picker collapses on the CHOICE LIST and not on the mode, which is what makes
//     that seam assertable at all;
//   • ONE ROW CONTROL, mounted with Upcoming's own props: the row that had no duration
//     and no confirm gets both by mounting the shared control rather than by having
//     them re-added to a copy;
//   • ONE SUBJECT SPELLING on every write either piece makes — the log, the correction,
//     and both halves of the live lifecycle, which is the pair a subject-blind control
//     would have leaked through.
//
// The COMPILE-time half of the convergence is not here and cannot be: what enforces it
// is the deletion of the old spellings, and a mount reaching for one fails `tsc`.

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  enqueue: vi.fn(),
}));
const ledger = vi.hoisted(() => ({ blocked: false }));

vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice: async (fd: FormData) => {
    record("logPractice")(fd);
    return { kind: "logged" as const, count: 1, date: String(fd.get("date")) };
  },
  editPracticeSession: async (fd: FormData) => {
    record("editPracticeSession")(fd);
    return { kind: "updated" as const, session: {} };
  },
  startPracticeLive: async (fd: FormData) => {
    record("startPracticeLive")(fd);
    return {
      kind: "started" as const,
      session: {
        id: 5,
        date: "2026-08-20",
        startTime: "09:00",
        expectedEnd: null,
      },
      count: 1,
      date: "2026-08-20",
    };
  },
  endPracticeLive: async (fd: FormData) => {
    record("endPracticeLive")(fd);
    return {
      kind: "ended" as const,
      session: {},
      count: 1,
      date: "2026-08-20",
    };
  },
}));
const toasts: string[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => toasts.push(text),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => mocks.confirm,
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: mocks.enqueue }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/FormatPrefsProvider", () => ({
  useFormatPrefs: () => ({ timeFormat: "24h", dateFormat: "iso" }),
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => {
    fd.set("logged_via", "page");
    return fd;
  },
}));
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    affordance: "practice-session",
    blocked: () => ledger.blocked,
    pending: () => false,
    tap: async (spec: {
      write: () => Promise<unknown>;
      settle: (outcome: unknown) => unknown;
    }) => {
      spec.settle(await spec.write());
    },
  }),
}));

const TODAY = "2026-08-20";
const FOUND_DAY = "2026-08-18";
const SUBJECT = 42;
const ROW = {
  id: 7,
  date: FOUND_DAY,
  startTime: "07:15",
  endTime: "07:45",
  durationMin: 30,
  notes: "before breakfast",
};

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  toasts.length = 0;
  ledger.blocked = false;
  mocks.confirm.mockReset();
  mocks.enqueue.mockReset();
  cleanup();
});

function openForm(
  row?: typeof ROW,
  practices: string[] = ["Sauna"],
  subjectProfileId?: number
): void {
  render(
    <PracticeSessionForm
      practices={practices}
      today={TODAY}
      date={FOUND_DAY}
      row={row}
      subjectProfileId={subjectProfileId}
    />
  );
}

/** Every control the form draws, by its ACCESSIBLE NAME. The field SIGNATURE. */
function fieldSignature(): string[] {
  return [...document.querySelectorAll<HTMLElement>("input, select, textarea")]
    .filter((el) => el.getAttribute("type") !== "hidden")
    .map((el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      // Both shapes the form draws: a label WRAPPING its control, and — since the
      // start/end pair became the shared `TimeRangeFields` — a label pointing at one
      // by `for`. Reading only the first would flatten every field in the shared pair
      // to "INPUT", and a signature that cannot tell Start from End is not one.
      const forLabel = el.id && document.querySelector(`label[for="${el.id}"]`);
      if (forLabel) return forLabel.textContent?.trim() ?? "";
      const label = el.closest("label");
      if (!label) return el.tagName;
      return [...label.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
    })
    .sort();
}

function payload(action: string, index = 0): Record<string, string> {
  const all = posted[action] ?? [];
  expect(
    all.length,
    `${action} was handed ${all.length} payloads`
  ).toBeGreaterThan(index);
  return Object.fromEntries(
    [...all[index].entries()].map(([k, v]) => [k, String(v)])
  );
}

async function save(label: string): Promise<void> {
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: label }))
  );
}

describe("PracticeSessionForm is ONE form for add and for edit", () => {
  it("draws the same fields in both modes and differs only in seed and action", async () => {
    openForm();
    const addFields = fieldSignature();
    const addSeed = (screen.getByLabelText("Start") as HTMLInputElement).value;
    await save("Log session");
    const added = payload("logPractice");

    cleanup();
    openForm(ROW);
    // THE SEAM. Not "both surfaces render a duration box" — the whole named field set,
    // so a field that appears in one mode and not the other reddens this.
    expect(fieldSignature()).toEqual(addFields);
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      ROW.startTime
    );
    expect(addSeed).not.toBe(ROW.startTime);
    await save("Save");
    const edited = payload("editPracticeSession");

    // Same wire shape but for the row's id, which is the whole of what an edit adds:
    // a session is addressed by a row id, and add mode has none to name.
    expect(Object.keys(edited).sort()).toEqual(
      [...Object.keys(added), "id"].sort()
    );
    expect(edited.notes).toBe(ROW.notes);
    expect(added.notes).not.toBe(edited.notes);
  });

  // THE PICKER COLLAPSES ON THE CHOICE LIST, NOT ON THE MODE. If it collapsed on the
  // mode the seam above would be untestable — add and edit would differ by a field by
  // construction — so this is the property that makes one layout possible.
  it.each([
    ["add", undefined],
    ["edit", ROW],
  ] as const)(
    "draws the picker in %s mode when the mount hands several",
    (_mode, row) => {
      openForm(row, ["Sauna", "Breathwork"]);
      expect(screen.getByTestId("practice-form-picker")).toBeTruthy();
      cleanup();
      openForm(row, ["Sauna"]);
      expect(screen.queryByTestId("practice-form-picker")).toBeNull();
    }
  );

  // THE END IS STATEABLE AT EVERY MOUNT, which is the behaviour four spellings cost.
  // The `/history` door and that record row each stated a START and no end, so a window
  // stated in the expanded form was correctable on exactly one surface.
  it("states a window, in both modes, through the same two fields", async () => {
    openForm();
    fireEvent.change(screen.getByLabelText("Start"), {
      target: { value: "06:00" },
    });
    fireEvent.change(screen.getByLabelText("End"), {
      target: { value: "06:30" },
    });
    await save("Log session");
    expect(payload("logPractice")).toMatchObject({
      start_time: "06:00",
      end_time: "06:30",
    });

    cleanup();
    openForm(ROW);
    fireEvent.change(screen.getByLabelText("End"), {
      target: { value: "08:05" },
    });
    await save("Save");
    expect(payload("editPracticeSession")).toMatchObject({
      start_time: ROW.startTime,
      end_time: "08:05",
    });
  });

  // THE START IS PRESENCE-POSTED, NOT VALUE-GATED (#2204). An untouched clock must post
  // an EMPTY field rather than no field: absent means "you have the clock" and would
  // stamp the filing minute onto a day that is not today.
  it("posts an empty start rather than none when the reader states no time", async () => {
    openForm();
    await save("Log session");
    const added = payload("logPractice");
    expect(added.start_time).toBe("");
    expect("start_time" in added).toBe(true);
  });
});

// #4384 FIX 6 — THE WINDOW AND THE DURATION READ EACH OTHER, through the pair the
// activity form already mounted (`components/TimeRangeFields.tsx`). The form shipped
// four uncoupled boxes: nothing derived, no shortcut was offered, and an end before its
// start was accepted and written. Asserted in BOTH modes because "the details modal and
// the session-history edit form" are this one component — which is the whole reason the
// interplay could be added once instead of twice.
describe("the window and the duration read each other (#336's interplay)", () => {
  const start = () => screen.getByLabelText("Start") as HTMLInputElement;
  const end = () => screen.getByLabelText("End") as HTMLInputElement;
  const duration = () => screen.getByLabelText("Duration") as HTMLInputElement;

  // A DIFFERENT STATED START PER ROW, deliberately. The fixture's start replaced a
  // value read off the wall clock (#4998), and a constant shared by both rows would
  // let a `derivedEnd` that ignored `startTime` entirely — hardcoding this very
  // constant — pass both. Two different starts put `startTime` back in the loop: the
  // final assertion below reads the offer against `start().value`, so an offer that
  // stopped depending on it can only satisfy one row.
  it.each([
    ["add", undefined, "09:00"],
    ["edit", ROW, "14:05"],
  ] as const)(
    "%s mode: a stated clock offers the other at the duration's distance, then the third derives",
    (_mode, row, statedStart) => {
      openForm(row);
      // Cleared first, so what the case measures is the interplay and not the seed.
      fireEvent.change(start(), { target: { value: "" } });
      fireEvent.change(end(), { target: { value: "" } });
      fireEvent.change(duration(), { target: { value: "30" } });

      // With no clock stated, each side offers the one thing it can: now.
      expect(screen.getByTestId("start-time-shortcut").textContent).toBe("now");
      fireEvent.click(screen.getByTestId("start-time-shortcut"));
      expect(start().value).toMatch(/^\d\d:\d\d$/);

      // …and then the Start is STATED OUTRIGHT, which is what the rest of this case
      // is about. Reading it from the "now" click instead made these two cases fail
      // every night between 23:30 and midnight (#4998): the `+30m` offer is
      // `shiftHHMM(start, 30)`, which is same-day by contract and returns null past
      // 23:59, so the control correctly fell back to its own `now` offer and the
      // assertion below read a real behaviour as a regression. Nothing about a
      // duration's distance depends on which minute of the day it is measured from,
      // so the fixture states one rather than borrowing the wall clock — the unit-tier
      // face of e2e-hygiene item 20 (#4963).
      fireEvent.change(start(), { target: { value: statedStart } });

      // Once a Start is stated, the OTHER side offers the duration instead — which is
      // the offer this form had no way to make.
      const offer = screen.getByTestId("end-time-shortcut");
      expect(offer.textContent).toBe("+30m");
      fireEvent.click(offer);
      expect(end().value).toBe(shiftHHMM(start().value, 30));

      // …and with both clocks stated the duration stops being a second place to type
      // one: it is the span, and it says where it came from.
      expect(duration().readOnly).toBe(true);
      expect(duration().value).toBe("30");
      expect(screen.getByText("Calculated from start and end.")).toBeTruthy();
    }
  );

  it("refuses an end before its start, in the activity form's words", async () => {
    openForm();
    fireEvent.change(start(), { target: { value: "09:00" } });
    fireEvent.change(end(), { target: { value: "08:00" } });
    expect(
      screen.getByText("End time must be after the start time.")
    ).toBeTruthy();
    // The refusal is the SUBMIT's, not the message's — asserted on the button rather
    // than on "nothing was posted", because the end input's `min` makes the click a
    // no-op either way and would satisfy that check on a form with no refusal in it.
    const submit = () =>
      screen.getByTestId("practice-log-detailed-submit") as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    await save("Log session");
    expect(posted.logPractice ?? []).toHaveLength(0);

    // THE CONVERSE, because "nothing was posted" is also what a broken form does:
    // correct the end and the same click writes.
    fireEvent.change(end(), { target: { value: "09:40" } });
    expect(submit().disabled).toBe(false);
    await save("Log session");
    expect(payload("logPractice")).toMatchObject({
      start_time: "09:00",
      end_time: "09:40",
      duration_min: "40",
    });
  });
});

describe("the subject is spelled once, on every write either piece makes", () => {
  it.each([
    ["add", undefined, "logPractice", "Log session"],
    ["edit", ROW, "editPracticeSession", "Save"],
  ] as const)(
    "the form's %s mode posts profile_id and no second name",
    async (_mode, row, action, label) => {
      openForm(row, ["Sauna"], SUBJECT);
      await save(label);
      const sent = payload(action);
      expect(sent.profile_id).toBe(String(SUBJECT));
      // The retired spelling, asserted ABSENT: #4238's convergence is that one field
      // names the subject, and a second name is how a gate ends up reading one of two.
      expect("profileId" in sent).toBe(false);
    }
  );

  // BOTH HALVES OF THE LIFECYCLE, because this is the pair a subject-blind control
  // leaks through: a mount on a household member's row that logged to the member and
  // STARTED for the caregiver would look right on screen and be wrong in the store.
  it("the control's log, start and end all name the row's subject", async () => {
    const mount = (liveSession?: {
      id: number;
      date: string;
      startTime: string;
      expectedEnd: null;
    }) => (
      <LogPracticeButton
        practice="Sauna"
        todayCount={0}
        today={TODAY}
        subjectProfileId={SUBJECT}
        liveSession={liveSession ?? null}
      />
    );
    const { rerender } = render(mount());
    fireEvent.click(screen.getByTestId("practice-log-button"));
    await waitFor(() => expect(posted.logPractice ?? []).toHaveLength(1));
    fireEvent.click(screen.getByTestId("practice-start-button"));
    await waitFor(() => expect(posted.startPracticeLive ?? []).toHaveLength(1));
    // The row holds no copy of the session it just started (#5431): End appears when
    // the SERVER's row reaches the prop, which is what the real mounts re-read for.
    rerender(
      mount({
        id: 5,
        date: TODAY,
        startTime: "09:00",
        expectedEnd: null,
      })
    );
    fireEvent.click(await screen.findByTestId("practice-end-button"));
    await waitFor(() => expect(posted.endPracticeLive ?? []).toHaveLength(1));

    for (const action of [
      "logPractice",
      "startPracticeLive",
      "endPracticeLive",
    ]) {
      expect(payload(action).profile_id, action).toBe(String(SUBJECT));
    }
  });

  // A CROSS-PROFILE TAP NEVER QUEUES (the #1373 dose rule). The replay route carries no
  // target profile, so a captured session would land on the acting one — and the count
  // must not move either, since it is the control's claim that the session landed.
  it("goes online for a subject's tap instead of capturing it offline", async () => {
    // `onLine` lives on Navigator.PROTOTYPE, so there is no own descriptor to put back
    // — the restore is a DELETE, and getting that wrong leaves every later test in this
    // file running offline. It would not have reddened them (a subject's tap goes
    // online anyway), which is exactly why the leak is worth spelling out here.
    const own = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    expect(own, "navigator.onLine has an own descriptor now").toBeUndefined();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    try {
      render(
        <LogPracticeButton
          practice="Sauna"
          todayCount={0}
          today={TODAY}
          subjectProfileId={SUBJECT}
        />
      );
      fireEvent.click(screen.getByTestId("practice-log-button"));
      await waitFor(() => expect(posted.logPractice ?? []).toHaveLength(1));
      expect(mocks.enqueue).not.toHaveBeenCalled();

      // THE CONVERSE, or "never queues" would also be satisfied by a control that had
      // lost offline capture entirely: with no subject the same tap DOES capture.
      cleanup();
      for (const key of Object.keys(posted)) delete posted[key];
      mocks.enqueue.mockResolvedValue("kept");
      render(
        <LogPracticeButton practice="Sauna" todayCount={0} today={TODAY} />
      );
      fireEvent.click(screen.getByTestId("practice-log-button"));
      await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
      expect(posted.logPractice ?? []).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(window.navigator, "onLine");
      expect(window.navigator.onLine).toBe(true);
    }
  });
});

describe("Upcoming's row is a mount of the one control (#4424 ruling 7)", () => {
  // The props the Upcoming row hands it. The row used to front its own button and its
  // own action: no duration, no confirm, no lifecycle. Nothing here was added to that
  // button — it is the shared control, so the three arrive together.
  const upcoming = (todayCount: number) => (
    <LogPracticeButton
      practice="Sauna"
      todayCount={todayCount}
      today={TODAY}
      defaultDurationMin={20}
      inlineDuration
      compact
      primaryTone="neutral"
      subjectProfileId={SUBJECT}
    />
  );

  it("carries the duration the deleted door discarded, prefilled and posted", async () => {
    render(upcoming(0));
    const stepper = screen.getByTestId("practice-duration-input");
    expect((stepper as HTMLInputElement).value).toBe("20");
    fireEvent.click(screen.getByTestId("practice-log-button"));
    await waitFor(() => expect(posted.logPractice ?? []).toHaveLength(1));
    expect(payload("logPractice").duration_min).toBe("20");
  });

  // #4384 FIX 4 — the unit was the `placeholder`, so the stepper named what it counted
  // in the one state where a bare number is unambiguous (empty) and went silent in the
  // state where it is not.
  it("names its unit while it holds a value, not only while blank", async () => {
    render(upcoming(0));
    const stepper = screen.getByTestId("practice-inline-duration");
    expect(
      (screen.getByTestId("practice-duration-input") as HTMLInputElement).value
    ).toBe("20");
    expect(stepper.textContent).toContain("min");
    // …and the same word in the blank state, which is what the placeholder gave and
    // what this must not have taken away.
    fireEvent.change(screen.getByTestId("practice-duration-input"), {
      target: { value: "" },
    });
    expect(stepper.textContent).toContain("min");
  });

  it("asks before a second same-day session, and writes nothing when declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(upcoming(2));
    fireEvent.click(screen.getByTestId("practice-log-button"));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(posted.logPractice ?? []).toHaveLength(0);

    // AND THE CONFIRM IS THE DAY'S QUESTION, not a blanket one: the first session of a
    // day is a single tap, or this would be a block rather than the #798 question.
    cleanup();
    mocks.confirm.mockClear();
    render(upcoming(0));
    fireEvent.click(screen.getByTestId("practice-log-button"));
    await waitFor(() => expect(posted.logPractice ?? []).toHaveLength(1));
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
