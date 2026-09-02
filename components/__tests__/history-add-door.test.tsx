import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HistoryAddDoor, {
  type HistoryAddKind,
} from "@/app/(app)/history/HistoryAddDoor";

// WHAT THE RECORD'S ADD DOOR POSTS (#4045 §1).
//
// The door shipped as four redirect links, so there was nothing to post and nothing to
// test. Now each kind mounts that kind's backfill form in place, and the claim that
// matters is the same one `history-row-writes.test.tsx` makes about the ⋯: the payload
// reaches THE DOMAIN'S OWN CREATE ACTION, carrying the day the reader was looking at.
//
// NO SIXTH WRITE CORE, asserted structurally: the four mocks below are the four create
// actions those domains already had. A door that reached for anything else would post
// to something unmocked and fail here rather than quietly ship a fifth write path.
//
// THE DATE IS THE WHOLE POINT. "Losing the found context (the day you were looking at)"
// is the defect in the owner's own words, so every case asserts the posted `date` and
// not merely that something was posted.

const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
};

vi.mock("@/app/(app)/symptom-actions", () => ({
  logSymptom: async (fd: FormData) => {
    record("logSymptom")(fd);
    return {
      ok: true,
      symptom: String(fd.get("symptom")),
      severity: Number(fd.get("severity")),
    };
  },
  editSymptom: async () => ({ ok: false, error: "the door never corrects" }),
}));
vi.mock("@/app/(app)/nutrition/actions", () => ({
  logFoodServing: async (fd: FormData) => {
    record("logFoodServing")(fd);
    return { ok: true, servings: 1 };
  },
}));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  logHistoricalDose: async (fd: FormData) => {
    record("logHistoricalDose")(fd);
    return { ok: true };
  },
  updateHistoricalDose: async () => ({
    ok: false,
    error: "the Add door never corrects",
  }),
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  logPractice: async (fd: FormData) => {
    record("logPractice")(fd);
    return { kind: "logged" };
  },
}));
vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  addSubstanceDailyTotalAction: async (fd: FormData) => {
    record("addSubstanceDailyTotalAction")(fd);
    return { kind: "added" };
  },
}));
vi.mock("@/app/(app)/mood-actions", () => ({
  logMood: async (fd: FormData) => {
    record("logMood")(fd);
    return { ok: true };
  },
}));
// THE MEASUREMENTS ACTION, not a body-shaped one (#4424 ruling 2): the body kind
// mounts the domain's one form, so the door's write is the same action the quick-log
// sheet and the Trends panel post.
vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: async (fd: FormData) => {
    record("addMeasurements")(fd);
    return {};
  },
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: async () => "kept" }),
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
// #4118's pair: the composed write the one-tap posts, and the dated offer read the
// door consults when its date field moves. `offerReads` records every day asked about
// and `offerReply` decides what comes back, so a test can hold one answer open and
// prove the sequencing rather than assume it.
const offerReads: string[] = [];
let offerReply: (date: string) => Promise<UsualOffer[]> = async () => [];
// WHAT THE COMPOSED WRITE ANSWERED. Steerable, because `ok: true` does NOT mean every
// half landed: the core reports each dose separately and a day outside the dose half's
// own +/-2 window comes back `stale-dose` with the servings still committed. A mock
// fixed at `doses: []` can never reach that branch, which is exactly how the door
// shipped reporting a flat success for a write it had only partly performed.
type UsualReply = {
  ok: boolean;
  window?: string;
  groups?: { groupKey: string; servings: number; mealServings: number }[];
  doses?: { doseId: number; name: string; outcome: string }[];
  error?: string;
};
let usualReply: () => UsualReply = () => ({
  ok: true,
  window: "Morning",
  groups: [],
  doses: [],
});
vi.mock("@/app/(app)/actions", () => ({
  logUsualRoutine: async (fd: FormData) => {
    record("logUsualRoutine")(fd);
    return usualReply();
  },
  usualRoutineOffersOn: async (date: string) => {
    offerReads.push(date);
    return offerReply(date);
  },
}));

const refreshed: number[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => refreshed.push(1) }),
  useSearchParams: () => new URLSearchParams(),
}));
// THE TOAST IS AN ASSERTION SUBJECT, not scenery (#4118). It was a no-op mock, so the
// door could report a success it had not achieved and nothing here could see it.
const toasts: string[] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (text: string) => toasts.push(text),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));

beforeEach(() => {
  // The symptom door's picker is the shared Combobox, which observes its own box.
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  for (const key of Object.keys(posted)) delete posted[key];
  refreshed.length = 0;
  offerReads.length = 0;
  offerReply = async () => [];
  toasts.length = 0;
  usualReply = () => ({ ok: true, window: "Morning", groups: [], doses: [] });
  cleanup();
});

/** The day the reader is looking at, and the bound every door here is under. */
const FOUND_DAY = "2026-08-18";
const TODAY = "2026-08-29";

type UsualOffer = {
  window: "Morning" | "Midday" | "Evening";
  food: { slug: string; name: string }[];
  doses: { id: number; name: string; stack: string | null }[];
};

/** The composed bundle standing on the found day: two servings and one dose. */
const MORNING_OFFER: UsualOffer = {
  window: "Morning",
  food: [
    { slug: "berries", name: "Berries" },
    { slug: "fermented", name: "Fermented foods" },
  ],
  doses: [{ id: 41, name: "Creatine", stack: null }],
};

/** What the body domain's one form needs on the found day (`measurementsQuickEntry`). */
const MEASUREMENTS = {
  form: "measurements" as const,
  defaultDate: FOUND_DAY,
  defaultStatedAt: null,
  maxDate: TODAY,
  profileId: 7,
  weightUnit: "lb" as const,
  temperatureUnit: "F" as const,
  showBodyFat: true,
  showGrowth: false,
  showHeadCirc: false,
};

const VOCABULARY = {
  practices: ["Rowing", "Sauna"],
  substances: [
    { key: "nicotine", label: "Nicotine" },
    { key: "cannabis", label: "Cannabis" },
  ],
  symptoms: [
    { key: "headache", label: "Headache" },
    { key: "cough", label: "Cough" },
  ],
  measurements: MEASUREMENTS,
  moodDay: { date: FOUND_DAY, label: "Aug 18", mood: null },
  moodShowCalm: true,
  usual: [] as UsualOffer[],
  doseItems: [
    {
      id: 7,
      name: "Creatine",
      kind: "supplement" as const,
      product: null,
      asNeeded: false,
      doses: [{ id: 11, amount: "5 g", time_of_day: "Morning" }],
    },
  ],
  foodSlotBoundaries: { midday: 660, evening: 1020 },
    doseDefaultTime: "08:00",
};

function open(kind: HistoryAddKind, usual: UsualOffer[] = []): void {
  render(
    <HistoryAddDoor
      kind={kind}
      date={FOUND_DAY}
      maxDate={TODAY}
      vocabulary={{ ...VOCABULARY, usual }}
    />
  );
  fireEvent.click(screen.getByTestId(`history-add-open-${kind}`));
}

async function submit(kind: HistoryAddKind): Promise<void> {
  const panel = screen.getByTestId(`history-add-panel-${kind}`);
  const form = panel.querySelector("form")!;
  await act(async () => fireEvent.submit(form));
}

function only(action: string): Record<string, string> {
  const all = posted[action] ?? [];
  expect(all, `${action} was handed ${all.length} payloads`).toHaveLength(1);
  return Object.fromEntries(
    [...all[0].entries()].map(([k, v]) => [k, String(v)])
  );
}

describe("the record's Add door posts to the domain's own create action", () => {
  it("keeps the mood door on its day, clears it, and accepts a second save", async () => {
    open("mood");
    fireEvent.click(screen.getByText("Details"));
    fireEvent.click(screen.getByRole("button", { name: "Energy: 4" }));
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "clear afternoon" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    expect(only("logMood")).toMatchObject({
      date: FOUND_DAY,
      date_reach: "dated",
      valence: "4",
      energy: "4",
      factors: "work",
      note: "clear afternoon",
    });
    expect(refreshed).toHaveLength(1);
    expect(screen.getByTestId("history-add-panel-mood")).toBeTruthy();
    expect(screen.getByTestId("quick-mood-status").textContent).toBe(
      "Tap to log that day."
    );
    expect(
      screen
        .getByRole("button", { name: "Mood: Good" })
        .getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Energy: 4" })
        .getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Work" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe(
      ""
    );

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Mood: Good" }))
    );
    expect(posted.logMood).toHaveLength(2);
    expect(Object.fromEntries(posted.logMood![1]!.entries())).toMatchObject({
      date: FOUND_DAY,
      date_reach: "dated",
      valence: "4",
    });
    expect(refreshed).toHaveLength(2);
    expect(screen.getByTestId("history-add-panel-mood")).toBeTruthy();
  });

  it("keeps the dose form on its chosen day and resets it for a second save", async () => {
    open("dose");
    const chosenDay = "2026-08-17";
    fireEvent.change(screen.getByTestId("historical-dose-date"), {
      target: { value: chosenDay },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "7 g" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /adjust current supply/i })
    );

    await submit("dose");

    expect(posted.logHistoricalDose).toHaveLength(1);
    expect(
      Object.fromEntries(posted.logHistoricalDose![0]!.entries())
    ).toMatchObject({
      date: chosenDay,
      amount: "7 g",
      adjust_supply: "1",
    });
    expect(screen.getByTestId("history-add-panel-dose")).toBeTruthy();
    expect(
      (
        screen
          .getByTestId("historical-dose-form")
          .querySelector('input[name="date"]') as HTMLInputElement
      ).value
    ).toBe(chosenDay);
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      "5 g"
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /adjust current supply/i,
        }) as HTMLInputElement
      ).checked
    ).toBe(false);
    expect(refreshed).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "6 g" },
    });
    await submit("dose");

    expect(posted.logHistoricalDose).toHaveLength(2);
    expect(
      Object.fromEntries(posted.logHistoricalDose![1]!.entries())
    ).toMatchObject({
      date: chosenDay,
      amount: "6 g",
    });
    expect(screen.getByTestId("history-add-panel-dose")).toBeTruthy();
    expect(refreshed).toHaveLength(2);
  });

  // Each kind, the action it must reach, and the fields that make its write mean what
  // the door says it means. A table because the cases differ only in inputs and
  // expectations; what they share — the found day, the in-place resolution, the
  // re-read — is asserted for all four below the switch.
  it.each([
    [
      "food",
      "logFoodServing",
      { group_key: "leafy_greens", meal_slot: "Morning" },
    ],
    ["practice", "logPractice", { practice: "Rowing", start_time: "" }],
    [
      "substance",
      "addSubstanceDailyTotalAction",
      { substance: "nicotine", amount: "1" },
    ],
    ["body", "addMeasurements", { weight: "154", weight_unit: "lb" }],
    // THE DOMAIN'S OWN LOG CORE (#4424 ruling 2): the door is a date-context wrapper,
    // so the symptom kind reaches `logSymptom` — the same action a tap on the bar
    // posts — and never a door-shaped write of its own.
    ["symptom", "logSymptom", { symptom: "Headache", severity: "1" }],
  ] as [HistoryAddKind, string, Record<string, string>][])(
    "%s writes on the day the reader was looking at, through %s",
    async (kind, action, fields) => {
      open(kind);
      if (kind === "food") {
        fireEvent.change(
          screen.getByRole("combobox", { name: /food group/i }),
          { target: { value: "leafy_greens" } }
        );
      }
      if (kind === "body") {
        fireEvent.change(screen.getByRole("spinbutton", { name: /weight/i }), {
          target: { value: "154" },
        });
      }
      if (kind === "symptom") {
        fireEvent.change(screen.getByRole("combobox", { name: "Symptom" }), {
          target: { value: "Headache" },
        });
      }
      await submit(kind);
      const sent = only(action);
      expect(sent.date).toBe(FOUND_DAY);
      for (const [key, value] of Object.entries(fields)) {
        expect(sent[key], `${action} posted ${key}=${sent[key]}`).toBe(value);
      }
      // RESOLVED IN PLACE, WITH THE RESULT VISIBLE: the feed is re-read. Without it
      // the door writes silently and reads as dead — the same complaint as the
      // redirect it replaces.
      expect(refreshed).toHaveLength(1);
      // AND THE BODY DOOR STAYS OPEN on purpose (#4211, absorbed into #4424): the
      // shared form resets its own fields and keeps its date, so five readings
      // backfilled onto one past day are five quick saves. Asserted as the same
      // question for every kind, so a kind that silently changed side is visible.
      expect(screen.queryByTestId(`history-add-panel-${kind}`) !== null).toBe(
        kind === "body"
      );
    }
  );

  it("will not carry a date past today out of any kind's door", async () => {
    // NEVER THE FUTURE is the record's own rule and it is the one bound these four
    // doors share, so it is asked of the FIELD'S OWN VERDICT rather than of a `max`
    // attribute: `DateField` posts through a hidden input and enforces its range
    // through the Constraint Validation API, so an attribute assertion would read
    // `null` on a door that still had the bound and pass on one that had lost it.
    for (const kind of [
      "food",
      "practice",
      "substance",
      "body",
    ] as HistoryAddKind[]) {
      cleanup();
      open(kind);
      const panel = screen.getByTestId(`history-add-panel-${kind}`);
      const form = panel.querySelector("form")!;
      const typed =
        panel.querySelector<HTMLInputElement>('input[type="text"]')!;
      // The converse in the same assertion: the found day itself must pass, or
      // "refuses 2099" would also be satisfied by a field that refuses everything.
      expect(form.checkValidity(), `${kind} refuses the found day`).toBe(true);
      await act(async () => {
        fireEvent.change(typed, { target: { value: "2099-01-01" } });
      });
      expect(form.checkValidity(), `${kind} accepts a future day`).toBe(false);
    }
  });

  it("keeps ONE identity while its form is open, and offers nothing it cannot write", () => {
    // #3911's defect, not inherited (#2816): the dose launcher swaps its label to
    // "Cancel" while open. Dismissal belongs to the form these doors open.
    open("practice");
    expect(screen.getByTestId("history-add-open-practice").textContent).toBe(
      "Log a practice"
    );
    // And a profile with no practices gets no door at all rather than a select with
    // nothing in it — the same rule the dose door applies to items with no live dose.
    cleanup();
    render(
      <HistoryAddDoor
        kind="practice"
        date={FOUND_DAY}
        maxDate={TODAY}
        vocabulary={{ ...VOCABULARY, practices: [] }}
      />
    );
    expect(screen.queryByTestId("history-add-open-practice")).toBeNull();
  });

  it("refuses an out-of-range body reading inline instead of posting it", async () => {
    // The write cores SILENTLY SKIP a number outside their range, so a submission that
    // just posted would confirm a write that never happened. The shared form runs the
    // same pure guard (`validateBodyMetricInput`) the cores do and never posts.
    open("body");
    fireEvent.change(screen.getByRole("spinbutton", { name: /weight/i }), {
      target: { value: "9999" },
    });
    await submit("body");
    expect(posted.addMeasurements ?? []).toHaveLength(0);
    expect(screen.getByTestId("history-add-panel-body")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBeTruthy();
    expect(refreshed).toHaveLength(0);
  });

  // THE BACKFILL CAN NAME ITS OWN MINUTE (#3958's "WhenControl absolutes only",
  // #2236 invariant 4). Phase 1's doors carried a bare date and posted the time as a
  // hardcoded empty string, so a session backfilled from here could never say when it
  // happened — the record showed the filing clock for every one of them.
  //
  // Two kinds, because they are the two whose schema HAS an event instant and whose
  // create action already reads an absolute wall clock from the form: food's
  // `occurred_at` and practice's `start_time`. Substance is a day total with no event
  // column
  // and body's action deliberately states none, so neither gets a time field, and the
  // absence assertion below is what stops this drifting into "all four eventually".
  //
  // AND THE TWO NOW STATE IT THROUGH DIFFERENT CONTROLS, which is why the locator is
  // part of the table. Food keeps the door's `WhenControl`; the practice door mounts
  // the domain's one form (#4424 ruling 2), whose start/end PAIR is the range shape
  // `WhenControl` does not model and the reason it sits on the #2236 allowlist. The
  // claim being made is the same one either way: an absolute wall clock reaches the
  // action, and the day does not move under it.
  it.each([
    [
      "food",
      "logFoodServing",
      "occurred_at",
      () => screen.getByTestId("history-add-when-food-time"),
    ],
    [
      "practice",
      "logPractice",
      "start_time",
      () => screen.getByLabelText("Start"),
    ],
  ] as [HistoryAddKind, string, string, () => HTMLElement][])(
    "%s carries a stated time through to %s as %s",
    async (kind, action, field, timeField) => {
      open(kind);
      await act(async () => {
        fireEvent.change(timeField(), {
          target: { value: "07:15" },
        });
      });
      await submit(kind);
      const sent = only(action);
      // The WALL CLOCK, not an instant: both actions resolve it server-side against
      // the profile's timezone (#2053), so a browser-computed instant would be the
      // thing this control exists to stop being posted.
      expect(sent[field]).toBe("07:15");
      // And the day did not move under it — the pair is one value (#2236 invariant 1).
      expect(sent.date).toBe(FOUND_DAY);
    }
  );

  // AND IT STILL STATES NOTHING WHEN NOTHING WAS STATED — invariant 3. An untouched
  // time emits null, not now, so a backfill that names no minute keeps saying so.
  // This is the converse of the case above and it is the half phase 1 got right: a
  // control that defaulted to the current clock would make every backfilled row claim
  // a session time nobody gave it.
  it.each([
    ["food", "logFoodServing", "occurred_at"],
    ["practice", "logPractice", "start_time"],
  ] as [HistoryAddKind, string, string][])(
    "%s posts an empty %s when the reader states no time",
    async (kind, action, field) => {
      open(kind);
      await submit(kind);
      expect(only(action)[field]).toBe("");
    }
  );

  // A KIND OFFERS A TIME EXACTLY WHEN ITS ROW HAS AN INSTANT TO PUT ONE IN, and this
  // is the assertion that keeps that a decision rather than an accident. Substance is
  // date-only in the SCHEMA — `substance_daily_totals` is a day total with no event
  // instant (#3327) — so a time input there would collect a statement with nowhere to
  // be stored. Body is the converse and it CHANGED with #4424 ruling 2:
  // `body_metrics.occurred_at` has existed since migration 165, and the door's own
  // bare `DateField` was the only reason a reading backfilled from the record could
  // not say when it was taken. The domain's form carries the sitting's Time, so it can.
  it("offers a time exactly where the row has an instant to hold one", () => {
    open("substance");
    expect(screen.queryByTestId("history-add-when-substance-time")).toBeNull();
    expect(screen.getByTestId("history-add-panel-substance")).toBeTruthy();
    cleanup();
    open("body");
    // The shared form's own control (testId "m"), not a door-shaped one.
    expect(screen.getByTestId("m-time")).toBeTruthy();
  });
});

// ── THE ONE-TAP USUAL ON A PAST DAY (#4118) ──────────────────────────────────
//
// The acceptance criterion a person actually performs: an empty past day fills from
// the record's own add door. The write, its bound, its provenance and its audit are
// the core's and are proved at the db and action tiers; what only this tier can prove
// is that the CONTROL posts the day the reader is looking at, and that its label stops
// promising a day the field has moved off.
describe("the composed usual on the add door", () => {
  function usualButton() {
    return screen.getByTestId("history-add-usual-Morning");
  }

  it("posts the composed bundle on the day the reader was looking at", async () => {
    open("food", [MORNING_OFFER]);
    // THE LABEL IS THE PROMISE: it names every serving and every dose the tap writes,
    // and the count is both halves — a button promising less than it writes is the
    // defect `usualRoutineAttachmentFor` refuses in Telegram, and it is refused here.
    expect(usualButton().textContent).toContain("Your usual Morning (3)");
    expect(usualButton().textContent).toContain(
      "Berries and Fermented foods + Creatine"
    );

    await act(async () => fireEvent.click(usualButton()));
    const sent = only("logUsualRoutine");
    expect(sent.date).toBe(FOUND_DAY);
    expect(sent.meal_slot).toBe("Morning");
    expect(sent.groups).toBe("berries,fermented");
    expect(sent.dose_ids).toBe("41");
    // Resolved in place, exactly as the four forms are.
    expect(screen.queryByTestId("history-add-panel-food")).toBeNull();
    expect(refreshed).toHaveLength(1);
    // AND IT DID NOT GO THROUGH THE PER-ITEM DOOR. A one-tap that quietly posted
    // `logFoodServing` would satisfy every assertion above about the label and none
    // about the bundle: no dose, no audit, no backfill provenance.
    expect(posted.logFoodServing ?? []).toHaveLength(0);
  });

  it("re-reads the offer when the date field moves, and posts the NEW day", async () => {
    // The promise has to follow the field. An offer resolved once at render would keep
    // naming the found day's breakfast while the field said something else, and the
    // core — which re-derives against the day it is HANDED — would write a different
    // bundle or refuse.
    const OTHER_DAY = "2026-08-20";
    const EVENING_OFFER: UsualOffer = {
      window: "Evening",
      food: [
        { slug: "legumes", name: "Legumes" },
        { slug: "nuts_seeds", name: "Nuts and seeds" },
      ],
      doses: [],
    };
    offerReply = async () => [EVENING_OFFER];
    open("food", [MORNING_OFFER]);
    expect(screen.queryByTestId("history-add-usual-Morning")).toBeTruthy();

    await act(async () => {
      fireEvent.change(
        screen
          .getByTestId("history-add-when-food")
          .querySelector<HTMLInputElement>('input[type="text"]')!,
        { target: { value: OTHER_DAY } }
      );
    });

    expect(offerReads).toEqual([OTHER_DAY]);
    // The found day's bundle is GONE, not merely joined by the new one.
    expect(screen.queryByTestId("history-add-usual-Morning")).toBeNull();
    const evening = screen.getByTestId("history-add-usual-Evening");
    expect(evening.textContent).toContain("Your usual Evening (2)");

    await act(async () => fireEvent.click(evening));
    const sent = only("logUsualRoutine");
    expect(sent.date).toBe(OTHER_DAY);
    expect(sent.groups).toBe("legumes,nuts_seeds");
  });

  it("drops a LATE answer for a day the reader has already left", async () => {
    // Two date changes are two in-flight reads and the network may answer them in
    // either order. Without sequencing the first day's late reply repaints the label
    // with an offer for a day nobody is looking at — the label lying again, by a
    // different route. Resolved deliberately out of order here.
    const FIRST = "2026-08-20";
    const SECOND = "2026-08-21";
    let releaseFirst: (offers: UsualOffer[]) => void = () => {};
    offerReply = (date) =>
      date === FIRST
        ? new Promise<UsualOffer[]>((resolve) => {
            releaseFirst = resolve;
          })
        : Promise.resolve([]);
    open("food", []);
    const field = screen
      .getByTestId("history-add-when-food")
      .querySelector<HTMLInputElement>('input[type="text"]')!;

    await act(async () => {
      fireEvent.change(field, { target: { value: FIRST } });
    });
    await act(async () => {
      fireEvent.change(field, { target: { value: SECOND } });
    });
    expect(offerReads).toEqual([FIRST, SECOND]);
    // The abandoned day answers LAST, with a bundle.
    await act(async () => {
      releaseFirst([MORNING_OFFER]);
    });
    expect(screen.queryByTestId("history-add-usual-Morning")).toBeNull();
  });

  it("offers nothing where there is nothing to offer, and nowhere but the food door", async () => {
    // Three absences on one claim, because each is a different way the control could
    // appear where it must not: no habit on that day, a day past the bundle's reach
    // (the server answers `[]` through the same predicate the core gates on), and a
    // kind that has no breakfast to log at all.
    open("food", []);
    expect(screen.queryByTestId("history-add-usual")).toBeNull();
    cleanup();
    open("substance", [MORNING_OFFER]);
    expect(screen.queryByTestId("history-add-usual")).toBeNull();
    cleanup();
    // A read that fails leaves no standing promise about a day it could not ask about.
    offerReply = async () => {
      throw new Error("offline");
    };
    open("food", [MORNING_OFFER]);
    await act(async () => {
      fireEvent.change(
        screen
          .getByTestId("history-add-when-food")
          .querySelector<HTMLInputElement>('input[type="text"]')!,
        { target: { value: "2026-08-20" } }
      );
    });
    expect(screen.queryByTestId("history-add-usual")).toBeNull();
  });

  // ── THE ANSWER NAMES WHAT WAS WRITTEN (#232, #4118) ────────────────────────
  //
  // `ok: true` means the bundle wrote SOMETHING, not that every half landed. Both halves
  // now reach the same seven days (#4305), but a dose can still refuse on any of them —
  // an item paused between render and tap, a dose retired, a medication whose recorded
  // courses do not cover that day. The core reports each dose separately and refuses to
  // assume any away; the door must not flatten that into a confirm it did not earn, and
  // this door is the ONLY surface that can reach past yesterday's message, since the
  // dashboard has no date field and the Telegram tap is gated to the pointer window.
  //
  // BOTH DIRECTIONS ON ONE SHAPE. A test that only asserted the refusal would pass on a
  // door that reported every tap as a failure.
  it.each([
    [
      "a dose the day is out of reach for",
      [{ doseId: 41, name: "Creatine", outcome: "stale-dose" }],
      ["Logged Berries and Fermented foods", "Creatine not logged"],
      ["1 dose taken"],
    ],
    [
      "every dose landing",
      [{ doseId: 41, name: "Creatine", outcome: "logged" }],
      ["Logged Berries and Fermented foods", "1 dose taken"],
      ["not logged"],
    ],
    [
      "a dose logged off its own day",
      [{ doseId: 41, name: "Creatine", outcome: "logged-off-day" }],
      ["1 dose taken"],
      ["not logged"],
    ],
  ] as const)(
    "%s: the toast says so",
    async (_why, doses, mustSay, mustNotSay) => {
      usualReply = () => ({
        ok: true,
        window: "Morning",
        groups: [
          { groupKey: "berries", servings: 1, mealServings: 1 },
          { groupKey: "fermented", servings: 1, mealServings: 1 },
        ],
        doses: [...doses],
      });
      open("food", [MORNING_OFFER]);
      await act(async () => fireEvent.click(usualButton()));

      expect(toasts).toHaveLength(1);
      for (const phrase of mustSay) expect(toasts[0]).toContain(phrase);
      for (const phrase of mustNotSay)
        expect(toasts[0], `toast claimed "${phrase}"`).not.toContain(phrase);
      // NEVER the flat confirm, which is what shipped and is what made a refused dose
      // read as a success.
      expect(toasts[0]).not.toBe("Added to the record.");
    }
  );

  it("still says the plain sentence for the door's own per-item forms", async () => {
    // The converse at the OTHER end: `announce` is optional, so a form that writes one
    // row must keep the sentence it always had. Without this, moving the composed
    // bundle's answer into `submit` could have silently re-worded every door.
    //
    // FOOD, BECAUSE THE DOOR STILL OWNS ITS FORM. Three kinds mount their domain's own
    // form now (#4424 ruling 2) and those answer in the domain's words — the practice
    // door this case used to drive says "Logged past session", which is the shared
    // form's sentence and is asserted where that form lives.
    open("food");
    fireEvent.change(screen.getByRole("combobox", { name: /food group/i }), {
      target: { value: "leafy_greens" },
    });
    await submit("food");
    expect(toasts).toEqual(["Added to the record."]);
  });

  it("leaves the per-item form exactly where it was", async () => {
    // The one-tap is the FAST path and never the only one. A reader whose usual is not
    // what they ate must still be able to name a group, and the bundle button sits
    // ABOVE the form rather than inside it — nested, it would become a submit control
    // of that form and log the wrong thing.
    open("food", [MORNING_OFFER]);
    const panel = screen.getByTestId("history-add-panel-food");
    expect(panel.querySelector("form")!.contains(usualButton())).toBe(false);
    fireEvent.change(screen.getByRole("combobox", { name: /food group/i }), {
      target: { value: "leafy_greens" },
    });
    await submit("food");
    const sent = only("logFoodServing");
    expect(sent.date).toBe(FOUND_DAY);
    expect(sent.group_key).toBe("leafy_greens");
    expect(posted.logUsualRoutine ?? []).toHaveLength(0);
  });
});
