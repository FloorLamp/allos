import fs from "node:fs";
import path from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripComments } from "@/lib/__tests__/strip-comments";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import DoseHistoryPanel from "@/components/intake/DoseHistoryPanel";
import DayLedger from "@/app/(app)/nutrition/DayLedger";
import QuickDoseList from "@/components/quick-entry/QuickDoseList";
import { DayContextProvider, useDayContext } from "@/components/DayContext";
import BoundedDaySwitcher from "@/components/BoundedDaySwitcher";
import { SHEET_REACH } from "@/lib/log-manifest";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import type { LedgerGroup } from "@/lib/day-ledger";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// TWO PIECES FOR THE DOSE DOMAIN (#4424): `HistoricalDoseForm` and
// `DoseStatusControl`. What each claim here is about is the thing a COPY forgot.
//
// The form's claim is ruling 1's line-budget guard verbatim — "add and edit share ONE
// layout, differing only in seed and action" — so the two modes are asserted through
// the SAME rendered form rather than through two components that happen to agree.
//
// The control's claim is ruling 3's: one implementation, mounted by every dose row that
// hosts a write control. The two surfaces that used to draw their own — the day ledger,
// which picked between the tri-state and a hand-rolled Take/Skip pair on `isToday`, and
// the quick sheet, which drew a "Mark taken" button for today and an icon pair for a day
// behind it — are rendered here on a PAST day, because that is the arm each copy had.

const posted: FormData[] = [];
const mocks = vi.hoisted(() => ({
  logHistoricalDose: vi.fn(),
  updateHistoricalDose: vi.fn(),
  setDoseStatus: vi.fn(),
  logMedicationAdministration: vi.fn(),
  acceptDoseBandUpdate: vi.fn(async (_formData: FormData) => ({
    ok: true as const,
  })),
  declineDoseBandUpdate: vi.fn(async (_formData: FormData) => ({
    ok: true as const,
  })),
  addMeasurements: vi.fn(async (_formData: FormData) => ({})),
}));

vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (formData: FormData) => formData,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/TimezoneProvider", () => ({
  useTimezone: () => "UTC",
}));
vi.mock("@/components/FormatPrefsProvider", () => ({
  useFormatPrefs: () => ({ timeFormat: "24h", dateFormat: "iso" }),
}));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture:
    () =>
    (date: string, reach: unknown, capturedAt = new Date()) => ({
      dayContext: {
        parts: { profileId: 1, day: date, reach },
        key: "test-context",
        isPrimaryDay: date === "2026-08-28",
      },
      capturedAt,
      writeToken: Promise.resolve(0),
    }),
}));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => vi.fn(),
  useConfirmOpen: () => false,
}));
// The panel's rows are the shared EntryHistoryTable, whose ⋯ delete runs through
// `useUndoableDelete`. Only its Server Action import is stood in for; the hook itself
// is real, so the amend door below opens through the same menu the app draws.
vi.mock("@/app/(app)/undo-actions", () => ({
  undoDelete: vi.fn(),
  undoDeletes: vi.fn(),
}));
// The shared ledger stands in, but its `tap` RUNS the write: a stubbed one makes every
// click a no-op and any assertion about what a click posts passes vacuously.
vi.mock("@/components/useOptimisticLedger", () => ({
  useOptimisticLedger: () => ({
    pending: () => false,
    blocked: () => false,
    tap: async <T,>(op: {
      write: () => Promise<T>;
      settle: (outcome: T) => unknown;
    }) => op.settle(await op.write()),
  }),
}));
vi.mock("@/app/(app)/symptom-actions", () => ({
  logSymptom: vi.fn(async () => ({ ok: true })),
  editSymptom: vi.fn(async () => ({ ok: true })),
  lowerSymptom: vi.fn(async () => ({ ok: true })),
  setSymptomNote: vi.fn(async () => ({ ok: true })),
  removeSymptom: vi.fn(async () => ({ ok: true })),
  logTemperature: vi.fn(async () => ({ ok: true, degF: 98.6, flag: null })),
  activateIllnessForSymptoms: vi.fn(async () => ({ ok: true })),
  suggestSymptomsFromText: vi.fn(async () => ({ ok: false, reason: "empty" })),
}));
vi.mock("@/app/(app)/medications/actions", () => ({
  logMedicationAdministration: mocks.logMedicationAdministration,
  acceptDoseBandUpdate: mocks.acceptDoseBandUpdate,
  declineDoseBandUpdate: mocks.declineDoseBandUpdate,
}));
// The row's inline weight fixer posts the real body-metric action; only the Server
// Action import is stood in for, so the fixer itself is the shipped component.
vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: mocks.addMeasurements,
}));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  logHistoricalDose: mocks.logHistoricalDose,
  updateHistoricalDose: mocks.updateHistoricalDose,
  setDoseStatus: mocks.setDoseStatus,
  deleteAdministration: vi.fn(),
  resolveDayDoses: vi.fn(),
}));

const TODAY = "2026-08-28";
const YESTERDAY = "2026-08-27";
const TOMORROW = "2026-08-29";

const CREATINE = {
  id: 7,
  name: "Creatine",
  asNeeded: false,
  courseBound: false,
  doses: [
    { id: 11, amount: "5 g", time_of_day: "Morning" },
    { id: 12, amount: "5 g", time_of_day: "Evening" },
  ],
};
const MAGNESIUM = {
  id: 8,
  name: "Magnesium",
  asNeeded: false,
  courseBound: false,
  doses: [{ id: 21, amount: "200 mg", time_of_day: "Before sleep" }],
};

beforeEach(() => {
  posted.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  mocks.logHistoricalDose.mockImplementation(async (fd: FormData) => {
    posted.push(fd);
    return { ok: true };
  });
  mocks.updateHistoricalDose.mockImplementation(async (fd: FormData) => {
    posted.push(fd);
    return { ok: true };
  });
  mocks.setDoseStatus.mockImplementation(async (fd: FormData) => {
    posted.push(fd);
    return { ok: true, outcome: "logged" };
  });
  mocks.logMedicationAdministration.mockImplementation(async (fd: FormData) => {
    posted.push(fd);
    return { ok: true, outcome: "logged" };
  });
});
afterEach(() => cleanup());

function fields(): Record<string, string> {
  expect(posted, `${posted.length} payloads posted`).toHaveLength(1);
  return Object.fromEntries(
    [...posted[0]!.entries()].map(([k, v]) => [k, String(v)])
  );
}

async function submitForm(): Promise<void> {
  const form = screen.getByTestId("historical-dose-form") as HTMLFormElement;
  await act(async () => fireEvent.submit(form));
}

describe("one dose form, add and edit, one layout (#4424 ruling 1)", () => {
  // THE SEED AND THE ACTION ARE THE ONLY DIFFERENCE. Both rows below render the same
  // `historical-dose-form`, and what changes is which action it reaches and what it
  // opens holding. A second form component could satisfy neither line.
  it.each([
    {
      mode: "add",
      editing: undefined,
      action: "logHistoricalDose",
      expected: { id: "7", dose_id: "11", date: YESTERDAY, amount: "5 g" },
    },
    {
      mode: "full-statement edit",
      editing: {
        logId: 99,
        doseId: 12,
        date: "2026-08-20",
        statedAt: null,
        amount: "2.5 g",
      },
      action: "updateHistoricalDose",
      expected: {
        log_id: "99",
        dose_id: "12",
        date: "2026-08-20",
        amount: "2.5 g",
      },
    },
  ])(
    "$mode posts $action from the one form",
    async ({ editing, action, expected }) => {
      render(
        <HistoricalDoseForm
          items={[CREATINE]}
          initialDate={YESTERDAY}
          maxDate={TODAY}
          defaultTime="08:00"
          editing={editing}
          onDone={vi.fn()}
        />
      );

      expect(screen.getByTestId("historical-dose-form")).toBeTruthy();
      await submitForm();

      expect(
        action === "logHistoricalDose"
          ? mocks.logHistoricalDose
          : mocks.updateHistoricalDose
      ).toHaveBeenCalledTimes(1);
      expect(
        action === "logHistoricalDose"
          ? mocks.updateHistoricalDose
          : mocks.logHistoricalDose
      ).not.toHaveBeenCalled();
      expect(fields()).toMatchObject(expected);
    }
  );

  // THE PICKER IS THE FORM'S. It was spelled twice — the record door's launcher and the
  // Supplements tab's card — each building the option list its own way, so a door could
  // offer an item list the other did not.
  it("offers the items it was handed and resets the dose when one is chosen", () => {
    render(
      <HistoricalDoseForm
        items={[CREATINE, MAGNESIUM]}
        initialDate={YESTERDAY}
        maxDate={TODAY}
        defaultTime="08:00"
        onDone={vi.fn()}
      />
    );

    const picker = screen.getByTestId(
      "historical-dose-item-picker"
    ) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Creatine",
      "Magnesium",
    ]);

    fireEvent.change(picker, { target: { value: "8" } });
    // The dose that came WITH the item, not the one the previous item had selected —
    // the wrappers got this by remounting the whole form on a `key`, which also threw
    // away the date the reader had already chosen.
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    expect(amount.value).toBe("200 mg");
  });

  it("renders no picker where the mount already stands on one item", () => {
    render(
      <HistoricalDoseForm
        items={[MAGNESIUM]}
        initialDate={YESTERDAY}
        maxDate={TODAY}
        defaultTime="08:00"
        onDone={vi.fn()}
      />
    );
    expect(screen.queryByTestId("historical-dose-item-picker")).toBeNull();
  });

  it("defaults the amount by date without clobbering a manual edit", () => {
    render(
      <HistoricalDoseForm
        items={[
          {
            ...MAGNESIUM,
            doses: [
              {
                ...MAGNESIUM.doses[0]!,
                amount: "1000 mg",
                versions: [
                  {
                    effective_from: YESTERDAY,
                    amount: "500 mg",
                    amount_captured: 1,
                  },
                  {
                    effective_from: TODAY,
                    amount: "1000 mg",
                    amount_captured: 1,
                  },
                ],
              },
            ],
          },
        ]}
        initialDate="2026-08-26"
        maxDate={TODAY}
        defaultTime="08:00"
        onDone={vi.fn()}
      />
    );

    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    expect(amount.value).toBe("500 mg");
    expect(
      screen.getByText(
        "No amount was saved for this date. Using the oldest known amount."
      )
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Date and time taken" })
    );
    fireEvent.click(screen.getByRole("button", { name: "August 28, 2026" }));
    expect(amount.value).toBe("1000 mg");
    expect(
      screen.queryByText(
        "No amount was saved for this date. Using the oldest known amount."
      )
    ).toBeNull();

    fireEvent.change(amount, { target: { value: "750 mg" } });
    fireEvent.click(screen.getByRole("button", { name: "August 27, 2026" }));
    expect(amount.value).toBe("750 mg");
  });

  it("keeps a saved null snapshot blank when an existing log opens", async () => {
    render(
      <HistoricalDoseForm
        items={[CREATINE]}
        maxDate={TODAY}
        defaultTime="08:00"
        editing={{
          logId: 99,
          doseId: 11,
          date: YESTERDAY,
          statedAt: null,
          amount: null,
        }}
        onDone={vi.fn()}
      />
    );

    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(
      ""
    );
    await submitForm();
    expect(fields().amount).toBe("");
  });

  it("formats every dose option from the selected day's facts", () => {
    render(
      <HistoricalDoseForm
        items={[
          {
            ...CREATINE,
            doses: [
              {
                id: 11,
                amount: "1000 mg",
                time_of_day: "Evening",
                versions: [
                  {
                    effective_from: YESTERDAY,
                    amount: "500 mg",
                    time_of_day: "Morning",
                    amount_captured: 1,
                  },
                  {
                    effective_from: TODAY,
                    amount: "1000 mg",
                    time_of_day: "Evening",
                    amount_captured: 1,
                  },
                ],
              },
              CREATINE.doses[1]!,
            ],
          },
        ]}
        initialDate={YESTERDAY}
        maxDate={TODAY}
        defaultTime="08:00"
        onDone={vi.fn()}
      />
    );

    const picker = screen.getByRole("combobox", {
      name: "Scheduled dose",
    }) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      "500 mg · Morning",
      "5 g · Evening",
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Date and time taken" })
    );
    fireEvent.click(screen.getByRole("button", { name: "August 28, 2026" }));
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      "1000 mg · Evening",
      "5 g · Evening",
    ]);
  });
});

const DUE_DOSE = {
  doseId: 31,
  itemId: 7,
  name: "Creatine",
  detail: "5 g",
  stack: null,
  bucket: "Morning" as const,
  timeOfDay: "Morning",
  amountAssumed: false,
};

function ledgerGroups(dueDose = DUE_DOSE): LedgerGroup[] {
  return [
    {
      bucket: "Morning",
      servings: 0,
      doses: 1,
      rows: [
        {
          kind: "due",
          id: "due:Morning",
          bucket: "Morning",
          doses: [dueDose],
        },
        {
          kind: "dose",
          id: "dose:55",
          bucket: "Morning",
          hhmm: "08:06",
          clockKind: "logged",
          logId: 55,
          doseId: 32,
          itemId: 7,
          name: "Magnesium",
          detail: "200 mg",
          stack: null,
          status: "taken",
          skipReason: null,
          bundleId: null,
        },
      ],
    },
  ];
}

// The bucket's due row is a disclosure; its dose rows — the ones that carry a control
// — only exist once it is open, so a fixture that never expands it can never reach the
// state these assertions are about.
function renderLedger(date: string, dueDose = DUE_DOSE) {
  const view = render(
    <DayLedger
      date={date}
      groups={ledgerGroups(dueDose)}
      doseWritable
      prefs={{ timeFormat: "24h", dateFormat: "iso" }}
      keepApart={[]}
      dayContext={null}
      moveDays={[]}
      onCorrectServing={vi.fn()}
      onRemoveServing={vi.fn()}
      removingServingId={null}
    />
  );
  fireEvent.click(screen.getByTestId("ledger-due-group-Morning"));
  return view;
}

describe("one dose row control, any writable day (#4424 ruling 3)", () => {
  it("states when a past-day amount uses the oldest known value", () => {
    renderLedger(YESTERDAY, {
      ...DUE_DOSE,
      detail: "500 mg",
      amountAssumed: true,
    });

    const due = screen.getByTestId(`ledger-due-dose-${DUE_DOSE.doseId}`);
    expect(within(due).getByText("500 mg")).toBeTruthy();
    expect(
      within(due).getByText(
        "No amount was saved for this date. Using the oldest known amount."
      )
    ).toBeTruthy();
  });

  // THE LEDGER PICKED A CONTROL PER ROW ON `isToday`. Both days render the same one
  // now, so the assertion is a COMPARISON between two real renders rather than a count
  // against a constant: whatever the tri-state offers today, a day inside the window
  // offers too.
  it("offers the same control on a past day as on today", () => {
    renderLedger(TODAY);
    const onToday = screen
      .getAllByTestId("dose-status")
      .map((el) => el.getAttribute("data-variant"));
    cleanup();

    renderLedger(YESTERDAY);
    const onPastDay = screen
      .getAllByTestId("dose-status")
      .map((el) => el.getAttribute("data-variant"));

    expect(onPastDay).toEqual(onToday);
    // Both rows: the one the day still owes AND the one it already recorded. The
    // logged row's control was TODAY-ONLY, so a dose taken on the wrong past day
    // could be logged from this ledger and not un-logged from it.
    expect(onPastDay).toHaveLength(2);
    // No second spelling survives beside it.
    expect(screen.queryByTestId(`ledger-take-${DUE_DOSE.doseId}`)).toBeNull();
    expect(screen.queryByTestId(`ledger-skip-${DUE_DOSE.doseId}`)).toBeNull();
  });

  it("writes to the day the row stands on, not to today", async () => {
    renderLedger(YESTERDAY);
    const due = screen.getByTestId(`ledger-due-dose-${DUE_DOSE.doseId}`);

    await act(async () => {
      fireEvent.click(within(due).getByTestId("dose-take"));
    });

    expect(fields()).toMatchObject({
      dose_id: String(DUE_DOSE.doseId),
      status: "taken",
      date: YESTERDAY,
      // The state the control was showing, which is what makes the write a
      // resolution rather than an overwrite (#280).
      from: "clear",
    });
  });

  // The CLEAR's other half — a cleared dose returning to the due list — is only
  // observable across the revalidate that re-derives the day, so it is pinned in
  // e2e/dose-skip.spec.ts's take → skip → clear round trip rather than here.
  it("takes a resolved past day back, which the dated arm could not", async () => {
    renderLedger(YESTERDAY);
    const logged = screen.getByTestId("ledger-dose-55");

    await act(async () => {
      fireEvent.click(within(logged).getByTestId("dose-take"));
    });

    expect(fields()).toMatchObject({
      dose_id: "32",
      status: "clear",
      date: YESTERDAY,
      from: "taken",
    });
  });
});

describe("the quick sheet mounts the same control on both of its arms", () => {
  function SheetBody() {
    const day = useDayContext();
    return (
      <>
        <BoundedDaySwitcher />
        <QuickDoseList
          today={TODAY}
          selectedDay={day.parts.day}
          doses={[
            { doseId: 41, title: "Creatine", detail: null, dueText: "8:00am" },
          ]}
          pastDays={[
            {
              date: YESTERDAY,
              label: "Yesterday",
              slots: [
                {
                  bucket: "Morning",
                  doses: [
                    {
                      doseId: 41,
                      name: "Creatine",
                      detail: "5 g",
                      stack: null,
                      amountAssumed: false,
                    },
                  ],
                },
              ],
            },
          ]}
          onDone={vi.fn()}
        />
      </>
    );
  }

  function renderSheet() {
    return render(
      <DayContextProvider
        profileId={1}
        today={TODAY}
        reach={SHEET_REACH}
        backing={{ kind: "state", initialDay: TODAY }}
      >
        <SheetBody />
      </DayContextProvider>
    );
  }

  it.each([
    ["today", "Today", undefined],
    ["a switched-to day", "Yesterday", YESTERDAY],
  ])("%s posts through the one control", async (_label, tab, date) => {
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: tab }));

    // ONE control per row, and the same one on both arms: the today arm's "Mark taken"
    // form and the past arm's icon pair are both gone.
    expect(screen.getAllByTestId("dose-status")).toHaveLength(1);
    expect(screen.queryByTestId("quick-entry-dose-form-41")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("dose-take"));
    });

    const sent = fields();
    expect(sent).toMatchObject({
      dose_id: "41",
      status: "taken",
      from: "clear",
    });
    // The day is the ROW's, and today's row states none — the same post it always made.
    expect(sent.date).toBe(date);
  });

  it("keeps a cached former-today row visible and writes its explicit day", async () => {
    render(
      <DayContextProvider
        profileId={1}
        today={TOMORROW}
        reach={SHEET_REACH}
        backing={{ kind: "state", initialDay: TODAY }}
      >
        <QuickDoseList
          today={TODAY}
          profileToday={TOMORROW}
          selectedDay={TODAY}
          doses={[
            { doseId: 41, title: "Creatine", detail: null, dueText: "8:00am" },
          ]}
          pastDays={[]}
          onDone={vi.fn()}
        />
      </DayContextProvider>
    );

    expect(screen.getByTestId("quick-entry-dose-41")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("dose-take"));
    });
    expect(fields()).toMatchObject({
      dose_id: "41",
      status: "taken",
      from: "clear",
      date: TODAY,
    });
  });
});

// THE "EARLIER DOSE" STATEMENT TAKES ITS DAY FROM THE SURFACE (#4691, converged by
// #4426 under #4738's ruling 3). The row handed the WhenControl `minDate === maxDate
// === today`, so the illness cockpit could show a Yesterday toggle above a row that
// could only ever write today, and last night's dose had no path from the surface a
// parent was looking at. #4691 fixed that with a day RANGE inside the statement,
// because the card had no day of its own yet; the Today/Yesterday lift gave it one, and
// the ruling put the day back where it belongs. So the claim is the SAME pair, reached
// the other way round: the statement offers NO day field at all, and the day the write
// states is the day the card is standing on.
describe("the PRN row's earlier-dose statement takes the card's day (#4691/#4738)", () => {
  // The component reads its own "today" from the UTC zone it is handed, so the test
  // derives the pair the same way rather than pinning a literal that ages out.
  const TODAY_UTC = new Date().toISOString().slice(0, 10);
  const YESTERDAY_UTC = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  function row(): void {
    render(
      <QuickLogPrnControl
        identity={{ name: "Ibuprofen", rxcui: null }}
        itemId={31}
        name="Ibuprofen"
        doseAmount="200 mg"
        dayLabel="1 today · last 4:02pm"
        tz="UTC"
      />
    );
  }

  async function openStatement(): Promise<void> {
    await act(async () =>
      fireEvent.click(screen.getByTestId("prn-log-when-toggle"))
    );
  }

  it("offers no day field — the surface's day is fixed text", async () => {
    row();
    await openStatement();
    // The WhenControl draws a <span> when minDate === maxDate and the editable
    // DateField otherwise: which ELEMENT is here IS the claim. It reads "Today" here
    // because this mount stands on today, which is the day the write below states.
    const day = screen.getByTestId("prn-log-when-date");
    expect(day.tagName).toBe("SPAN");
    expect(day.textContent).toBe("Today");
    expect(
      screen.getByTestId("prn-log-options").querySelector('input[type="date"]')
    ).toBeNull();
  });

  it("posts the CARD's day beside the stated time, past day included", async () => {
    // The reach #4691 opened, kept — through the card rather than through a day field.
    // The provider stands on a day that has ended, which is the overnight case the
    // cockpit exists for; the statement still says only the minute.
    render(
      <CockpitDayProvider date={YESTERDAY_UTC}>
        <QuickLogPrnControl
          identity={{ name: "Ibuprofen", rxcui: null }}
          itemId={31}
          name="Ibuprofen"
          doseAmount="200 mg"
          dayLabel="1 today · last 4:02pm"
          tz="UTC"
        />
      </CockpitDayProvider>
    );
    await openStatement();
    // THE DAY IS WORDS, NEVER THE STORAGE SPELLING (#5489 fix 3). This used to read
    // `2026-09-06` — the raw `date` — beside a card whose own toggle said Yesterday.
    // It now says what the card says, and the card does not call a past day "Today".
    const stated = screen.getByTestId("prn-log-when-date").textContent!;
    expect(stated).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stated).not.toBe("Today");
    await act(async () =>
      fireEvent.change(screen.getByTestId("prn-log-when-time"), {
        target: { value: "19:15" },
      })
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("prn-log-custom"))
    );
    const fd = fields();
    expect(fd.offset).toBe("custom");
    expect(fd.time).toBe("19:15");
    expect(fd.date).toBe(YESTERDAY_UTC);
  });

  it("the same statement left on today still writes today", async () => {
    row();
    await openStatement();
    await act(async () =>
      fireEvent.change(screen.getByTestId("prn-log-when-time"), {
        target: { value: "08:05" },
      })
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("prn-log-custom"))
    );
    expect(fields().date).toBe(TODAY_UTC);
  });

  // THE PAYOFF OF THE DAY CONTEXT (#4691): the Meds row is a SIBLING of the Symptoms
  // section, and before the lift it could not see the toggle at all — one card showed
  // Yesterday while this row could only ever write today. It now reads the card's day,
  // so the two cannot disagree by construction rather than by both remembering to.
  it("opens its statement on the card's day when it is inside one", async () => {
    render(
      <CockpitDayProvider date={TODAY} altDate={YESTERDAY}>
        <QuickLogPrnControl
          identity={{ name: "Ibuprofen", rxcui: null }}
          itemId={31}
          name="Ibuprofen"
          doseAmount="200 mg"
          dayLabel="1 today · last 4:02pm"
          tz="UTC"
        />
      </CockpitDayProvider>
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("prn-log-when-toggle"))
    );
    await act(async () =>
      fireEvent.change(screen.getByTestId("prn-log-when-time"), {
        target: { value: "19:15" },
      })
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("prn-log-custom"))
    );
    // TODAY here is the card's primary day, which is where the provider starts.
    expect(fields().date).toBe(TODAY);
  });

  // …AND IT MOVES WITH THE TOGGLE. Both real siblings under one card: the Symptoms
  // bar renders the toggle, the Meds row reads the day it sets. This is the assertion
  // the whole lift exists for — before it, the toggle was local state inside the bar
  // and this row could not observe it at all.
  it("follows the toggle its SIBLING renders", async () => {
    render(
      <CockpitDayProvider date={TODAY} altDate={YESTERDAY}>
        <SymptomLogBar
          date={TODAY}
          altDate={YESTERDAY}
          initial={{}}
          initialNotes={{}}
          symptoms={[]}
          customNames={[]}
          suggestActivateIllness={false}
          showTitle={false}
        />
        <QuickLogPrnControl
          identity={{ name: "Ibuprofen", rxcui: null }}
          itemId={31}
          name="Ibuprofen"
          doseAmount="200 mg"
          dayLabel="1 today · last 4:02pm"
          tz="UTC"
        />
      </CockpitDayProvider>
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("symptom-day-alt"))
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("prn-log-when-toggle"))
    );
    await act(async () =>
      fireEvent.change(screen.getByTestId("prn-log-when-time"), {
        target: { value: "19:15" },
      })
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("prn-log-custom"))
    );
    expect(fields().date).toBe(YESTERDAY);
  });

  // THE CARD'S DAY RIDES BOTH ARMS (#5489 fix 1). The now-tap used to post
  // `offset=now` and NO day, so the action stamped the server's today — from a card
  // that might be standing on yesterday. Under a card the day is the surface's in both
  // arms; with no card there is no surface day to state, which is the action's own
  // rule and is what keeps a page left open across midnight a one-tap dose.
  it("the taken-now tap states the CARD's day, and none where there is no card", async () => {
    render(
      <CockpitDayProvider date={TODAY_UTC}>
        <QuickLogPrnControl
          identity={{ name: "Ibuprofen", rxcui: null }}
          itemId={31}
          name="Ibuprofen"
          doseAmount="200 mg"
          dayLabel="1 today · last 4:02pm"
          tz="UTC"
        />
      </CockpitDayProvider>
    );
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-now")));
    expect(fields().offset).toBe("now");
    expect(fields().date).toBe(TODAY_UTC);

    cleanup();
    posted.length = 0;
    row();
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-now")));
    expect(fields().offset).toBe("now");
    expect(fields().date).toBeUndefined();
  });

  // ON A DAY THAT HAS ENDED, THE TAP ASKS (#5489 fix 2, the #4686 ruling). The green
  // pill is the control a caregiver reaches for at 2 a.m.; on a card standing on a day
  // that has no "now" it must not stamp one silently. Two claims, because "it wrote
  // nothing" and "it asked" are different outcomes and only one of them is the ruling.
  it("asks for the minute instead of stamping one on a day that has ended", async () => {
    render(
      <CockpitDayProvider date={YESTERDAY_UTC}>
        <QuickLogPrnControl
          identity={{ name: "Ibuprofen", rxcui: null }}
          itemId={31}
          name="Ibuprofen"
          doseAmount="200 mg"
          dayLabel="1 today · last 4:02pm"
          tz="UTC"
        />
      </CockpitDayProvider>
    );
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-now")));
    expect(posted).toHaveLength(0);
    expect(screen.getByTestId("prn-log-options")).toBeTruthy();

    // …and the SAME tap, once a minute stands beside it, writes that minute on the
    // card's day rather than a "now" the day cannot supply.
    await act(async () =>
      fireEvent.change(screen.getByTestId("prn-log-when-time"), {
        target: { value: "23:30" },
      })
    );
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-now")));
    const fd = fields();
    expect(fd.offset).toBe("custom");
    expect(fd.time).toBe("23:30");
    expect(fd.date).toBe(YESTERDAY_UTC);
  });
});

// THE BAND RUNS AT THE TAP (#4713). #798's weight-band machinery had one consumer —
// the add/edit form — so the dose row rendered whatever milligram figure the item was
// last SAVED with. For a growing child that snapshot goes stale silently, and the
// label's own refusals were unreachable from the surface a dose is given from.
//
// The subject here is a 6-year-old at 12 kg (26.5 lb), whose ibuprofen label band is
// 100 mg; the item still carries the 160 mg it was saved with, so every claim below
// separates "what the label says now" from "what the row remembers".
describe("the PRN row states the child's label band at dose time (#4713)", () => {
  const CHILD: PediatricFormContext = {
    ageMonths: 72,
    weightKg: 12,
    weightDate: "2026-09-01",
    weightUnit: "kg",
    today: "2026-09-02",
    declinedDoseUpdates: [],
  };

  function row(
    pediatric: PediatricFormContext | null,
    over: {
      name?: string;
      doseAmount?: string;
      profileId?: number;
      identity?: Parameters<typeof QuickLogPrnControl>[0]["identity"];
    } = {}
  ) {
    render(
      <QuickLogPrnControl
        identity={
          over.identity ?? { name: over.name ?? "Ibuprofen", rxcui: null }
        }
        itemId={31}
        name={over.name ?? "Ibuprofen"}
        doseAmount={over.doseAmount ?? "100 mg"}
        dayLabel="None today"
        tz="UTC"
        profileId={over.profileId}
        pediatric={pediatric}
      />
    );
  }

  it("states the band the dose stands on, with the label caveat", () => {
    row(CHILD, {
      name: "Advil 200mg",
      identity: { name: "Advil 200mg", rxcui: "5640" },
    });
    const basis = screen.getByTestId("prn-band-basis").textContent!;
    expect(basis).toContain("100 mg · 24–35 lb band");
    expect(basis).toContain("confirm against your package");
    expect(screen.queryByTestId("prn-band-refusal")).toBeNull();
  });

  // THE LINE THE ISSUE EXISTS FOR, and the line that must not become a substitution.
  // A 26.5 lb child whose item still carries the 160 mg it was saved with: the row
  // SAYS the chart reads 100 mg for this weight, and goes on offering — and recording
  // — the 160 mg the item actually carries. Nothing on this surface may overwrite a
  // dose whose provenance the data does not record.
  it("reports a band that differs without changing what the tap writes", () => {
    row(CHILD, { doseAmount: "160 mg" });
    expect(screen.getByTestId("prn-band-basis").textContent).toContain(
      "Label band for this weight is 100 mg · 24–35 lb band"
    );
    expect(screen.getByTestId("prn-log-now").getAttribute("aria-label")).toBe(
      "Take Ibuprofen · 160 mg"
    );
  });

  it("refuses an adolescent's chart lookup while keeping the prescribed dose", () => {
    row({ ...CHILD, ageMonths: 192, weightKg: 60 }, { doseAmount: "600 mg" });
    expect(screen.getByTestId("prn-band-refusal").textContent).toContain(
      "under 12 years"
    );
    expect(screen.queryByTestId("prn-band-basis")).toBeNull();
    expect(screen.getByTestId("prn-log-now").getAttribute("aria-label")).toBe(
      "Take Ibuprofen · 600 mg"
    );
  });

  // THE POSITIVE CONTROL for the criterion that matters most. Same row, same stored
  // dose, four subjects that must all be the row that shipped — no band line, no
  // refusal, the item's own figure. The mL case is the third falsified example: a
  // volume-dosed combination liquid has no milligram figure to compare, so printing
  // the OTC monograph's band beside it would invite exactly the wrong substitution.
  it.each([
    { subject: "an adult profile", pediatric: null, over: {} },
    {
      subject: "an item with no label chart",
      pediatric: CHILD,
      over: { name: "Aspirin" },
    },
    {
      subject: "a dose that is not in milligrams",
      pediatric: CHILD,
      over: { name: "Tylenol with Codeine", doseAmount: "5 mL" },
    },
    {
      subject: "a combination product measured in milligrams",
      pediatric: CHILD,
      over: { name: "Tylenol with Codeine", doseAmount: "300 mg / 30 mg" },
    },
    {
      subject: "a resolved combination with a generic display name",
      pediatric: CHILD,
      over: {
        name: "Tylenol",
        identity: {
          name: "Tylenol",
          rxcui: "99999",
          rxcuiIngredients: ["161", "2670"],
        },
      },
    },
  ])("leaves $subject exactly as it was", ({ pediatric, over }) => {
    row(pediatric, over);
    expect(screen.queryByTestId("prn-band-basis")).toBeNull();
    expect(screen.queryByTestId("prn-band-refusal")).toBeNull();
    expect(
      screen.getByTestId("prn-log-now").getAttribute("aria-label")
    ).toContain(over.doseAmount ?? "100 mg");
  });

  // THE REFUSALS ARE NOT GATED BY THE UNITS THE DOSE IS WRITTEN IN. The milligram
  // check above suppresses the band FIGURE, and a refusal carries none — so an infant
  // whose dose is written as a volume gets the same verdict a milligram-spelled one
  // does. It matters because the dataset's own infant formulations are `50 mg /
  // 1.25 mL` and `160 mg / 5 mL`: a volume IS how an infant dose is written, and the
  // add form refuses for every one of these inputs.
  it.each([
    { spelling: "milligrams", doseAmount: "50 mg" },
    { spelling: "a volume", doseAmount: "1.25 mL" },
  ])(
    "states the label's age gate for a 4-month-old dosed in $spelling",
    ({ doseAmount }) => {
      row({ ...CHILD, ageMonths: 4, weightKg: 6 }, { doseAmount });
      // Ibuprofen's chart starts at 6 months; below it the label's own words stand in
      // for any dose, and no band figure is printed beside either spelling.
      expect(screen.getByTestId("prn-band-refusal").textContent).toContain(
        "months"
      );
      expect(screen.queryByTestId("prn-band-basis")).toBeNull();
    }
  );

  // A MISSING WEIGHT DATE READS AS STALE (#798), and under 12 months the threshold is
  // 60 days — the infant case the machinery was built for, and the one that was
  // unreachable from this row. The fixer is one tap away in place, and the weight it
  // writes is the SUBJECT's: this row carries a `profileId` exactly when the acting
  // login is somebody else, which for an infant is always.
  it("surfaces the stale-weight refusal and fixes the SUBJECT's weight in place", async () => {
    const infant = { ...CHILD, ageMonths: 8, weightKg: 5, weightDate: null };
    row(infant, { doseAmount: "160 mg", profileId: 99 });
    expect(screen.getByTestId("prn-band-refusal").textContent).toContain(
      "over 60 days old"
    );
    expect(screen.queryByTestId("prn-band-basis")).toBeNull();

    // Not open on arrival: a list refuses per row for ONE fact, so N rows would mount
    // N editors. One tap opens it where it stands.
    expect(screen.queryByTestId("pediatric-weight-input")).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByTestId("pediatric-weight-update-open"))
    );
    fireEvent.change(screen.getByTestId("pediatric-weight-input"), {
      target: { value: "12" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );

    // THE WEIGHT IS THE CHILD'S. Without this the body-metric write falls back to
    // `gateItemProfile`'s acting profile and files an infant's weight on the parent.
    const posted = mocks.addMeasurements.mock.calls.at(-1)![0];
    expect(posted.get("weight")).toBe("12");
    expect(posted.get("profile_id")).toBe("99");

    // …and the refusal is answered in place, with the band now stated.
    expect(screen.queryByTestId("prn-band-refusal")).toBeNull();
    expect(screen.getByTestId("prn-band-basis").textContent).toContain(
      "Label band for this weight is 100 mg · 24–35 lb band"
    );
  });
});

// ADDS FOLLOW THE SURFACE ON A SUBJECT-SCOPED CONTAINER (#4693, amending #4424
// ruling 4). `/medications/[id]` names one profile, so its dose-history panel writes
// that profile — and the panel has TWO doors onto the same backfill, the form and the
// missed-day offer, which build their FormData separately. A subject threaded to one
// and not the other files half the page on the caregiver, and nothing on screen says
// so, which is why both doors are driven here rather than the more convenient one.
//
// The absent case is the other half of the claim and not a formality: it is every
// single-subject mount in the app, and it is what makes the action's gate fall back to
// the acting profile instead of the panel quietly naming a subject everywhere.
describe("the dose-history panel posts its container's subject (#4693)", () => {
  const PANEL = {
    itemId: 7,
    itemName: "Creatine",
    product: null,
    doses: [{ id: 11, amount: "5 g", time_of_day: "08:00" }],
    asNeeded: false,
    history: [],
  };

  it.each([
    { mount: "a subject-scoped container", subjectProfileId: 42, posted: "42" },
    {
      mount: "a single-subject page",
      subjectProfileId: undefined,
      posted: undefined,
    },
  ])(
    "$mount posts profile_id=$posted from the form AND the missed-day offer",
    async ({ subjectProfileId, posted: expected }) => {
      // A strip with one settled missed day, so the offer row is offered at all; the
      // trailing pending day keeps `missedDoseDays` from reading the miss as "today".
      render(
        <DoseHistoryPanel
          {...PANEL}
          strip={[
            { date: YESTERDAY, state: "missed" },
            { date: TODAY, state: "missed" },
          ]}
          maxDate={TODAY}
          defaultTime="08:00"
          courseBound={false}
          subjectProfileId={subjectProfileId}
        />
      );

      await act(async () =>
        fireEvent.click(screen.getByTestId("dose-history-add"))
      );
      await act(async () =>
        fireEvent.click(screen.getByTestId("dose-backfill-offer"))
      );
      expect(fields().profile_id).toBe(expected);

      posted.length = 0;
      await act(async () =>
        fireEvent.click(screen.getByTestId("dose-history-add"))
      );
      await act(async () =>
        fireEvent.click(screen.getByTestId("dose-backfill-other"))
      );
      await submitForm();
      expect(fields().profile_id).toBe(expected);
    }
  );
});

// AND IT COLLECTS ON THAT SUBJECT'S CLOCK (#4693 fix round). The id above is only half
// the pair: both of this panel's forms COLLECT A WALL CLOCK, and `updateHistoricalDose`
// / `logHistoricalDose` re-anchor it in the GATED profile's zone. A panel that named the
// subject and collected on the caregiver's calendar moved the administration time on a
// save with nothing edited — and the action could not refuse it, because the shifted
// instant's subject-local DATE still matched the posted date.
//
// The pair is `HistoryRows.tsx:529`'s, which passes `subjectProfileId` AND `tz` for this
// exact reason. Asserted here as a CLOCK, not as an id: the acting profile is the file's
// UTC `useTimezone` and the subject is eleven hours behind it, so every value below
// differs between the two zones while the DAY does not.
describe("the dose-history panel collects its subject's wall clock (#4693)", () => {
  const SUBJECT = 42;
  // UTC−11, no DST — so the offset is the same on every day this suite names.
  const SUBJECT_TZ = "Pacific/Niue";
  // 05:00Z on the 28th: the caregiver's today is TODAY, the subject's is YESTERDAY at
  // 18:00. Frozen because "today" is a rendered state here (the Now offer), not an input.
  const NOW = "2026-08-28T05:00:00Z";

  const PANEL = {
    itemId: 7,
    itemName: "Creatine",
    product: null,
    doses: [{ id: 11, amount: "5 g", time_of_day: "08:00" }],
    asNeeded: false,
    courseBound: false,
    defaultTime: "08:00",
    subjectProfileId: SUBJECT,
    tz: SUBJECT_TZ,
  };

  // 20:30Z on the 20th is 09:30 on the SUBJECT's 20th and 20:30 on the caregiver's.
  // BOTH are that day, which is why the pair rule at the write boundary sees nothing.
  const ROW = {
    id: 77,
    doseId: 11,
    date: "2026-08-20",
    time: "9:30am",
    statedAt: "2026-08-20 20:30:00",
    amount: "5 g",
    product: null,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as any;
  });
  afterEach(() => vi.useRealTimers());

  it("amends a row unchanged and posts the time back unmoved", async () => {
    render(<DoseHistoryPanel {...PANEL} maxDate={TODAY} history={[ROW]} />);

    fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }))
    );
    // READ BEFORE SAVING: the editor opening on the caregiver's clock is the same
    // defect seen one step earlier, and the form unmounts on success.
    expect(
      (screen.getByTestId("historical-dose-time") as HTMLInputElement).value
    ).toBe("09:30");

    await submitForm();
    // Nothing was edited, so nothing may move. `toMatchObject` on the three fields
    // that carry the statement; the id half is the suite above's.
    expect(fields()).toMatchObject({
      log_id: "77",
      date: "2026-08-20",
      time: "09:30",
      profile_id: String(SUBJECT),
    });
  });

  // THE ADD DOOR'S "NOW", which is the same root and the symptom a reader meets first:
  // the chip decides whether to render AND what to fill from the zone it was handed, so
  // on the caregiver's it is offered on the wrong day and fills the wrong hour. The
  // subject's today is YESTERDAY here, so a chip drawn on the caregiver's today is not
  // drawn at all — and the assertion is the posted clock, not the chip's presence.
  it("offers Now on the subject's today and fills the subject's clock", async () => {
    render(<DoseHistoryPanel {...PANEL} maxDate={YESTERDAY} history={[]} />);

    await act(async () =>
      fireEvent.click(screen.getByTestId("dose-history-add"))
    );
    await act(async () =>
      fireEvent.click(screen.getByTestId("historical-dose-now"))
    );
    await submitForm();
    expect(fields()).toMatchObject({
      date: YESTERDAY,
      time: "18:00",
      profile_id: String(SUBJECT),
    });
  });
});

// AND THE ONE MOUNT THAT SUPPLIES BOTH (#4693). Everything above renders the panel
// DIRECTLY, handing it `subjectProfileId` and `tz` from the test — which is what makes
// the claims readable, and also what makes them blind to the seam they exist to guard.
// `MedicationCard` is the only mount that passes either prop, so deleting one of them
// there left every tier in this repository green while re-opening the exact defect: the
// panel simply receives `undefined` and falls back, silently, to the acting profile and
// the caregiver's clock.
//
// A RENDER TEST CANNOT REACH IT WITHOUT A WHOLE CARD FIXTURE, which buys far more than
// this seam needs, so the seam is read as SOURCE — through the SHARED `stripComments`
// (a hand-rolled stripper is a known defect class, registered in
// lib/__tests__/strip-comments.test.ts). Scoped to the element and not to the file
// because `tz={timezone}` appears three times in that card for three different
// components; only this one is the panel's.
describe("the medication card hands the panel both halves (#4693)", () => {
  // `process.cwd()`, not `import.meta.url`: this tier runs in jsdom, where the module
  // URL is not a file: URL — the idiom of the two component censuses beside it.
  const REPO = process.cwd();
  const mount = (): string => {
    const src = stripComments(
      fs.readFileSync(
        path.join(REPO, "app/(app)/medications/MedicationCard.tsx"),
        "utf8"
      )
    );
    return /<DoseHistoryPanel\b[\s\S]*?\/>/.exec(src)?.[0] ?? "";
  };

  it("finds the mount it is guarding", () => {
    // The canary. A renamed component or a reshaped element leaves the matcher below
    // asserting about an empty string, which every `not.toMatch` would pass.
    expect(mount()).toMatch(/^<DoseHistoryPanel\b/);
  });

  it("passes the subject's id and the subject's zone to it", () => {
    // The PAIR, in one assertion, because half of it is the whole defect either way:
    // an id with no zone shifts the stated time on a save with nothing edited, and a
    // zone with no id files the caregiver.
    expect(mount()).toMatch(/subjectProfileId=\{subjectProfileId\}/);
    expect(mount()).toMatch(/\btz=\{timezone\}/);
  });
});

// THE OFFER TO FOLLOW THE CURRENT WEIGHT (#5538), and WHERE IT SITS. A child's dose
// row states the current band while every tap still records the stored figure; the
// ruling is to ask, on the DOSE ROW, immediately below the band statement, on all four
// dose hosts — which is one seat here, because all four mount this row.
//
// The two claims that are not about wording: the offer is BELOW the statement it
// disagrees with, and the Take chip is not gated by it. The 2 a.m. path this row exists
// for is one tap, and an offer that turned it into a decision would be the per-tap
// confirm the ruling rejected.
describe("the dose row offers to follow the current weight (#5538)", () => {
  // A six-year-old at 17 kg (37.5 lb) is in ibuprofen's 36–47 lb band: 150 mg. The item
  // still carries the 100 mg its add form banded when the child was smaller.
  const GROWN: PediatricFormContext = {
    ageMonths: 72,
    weightKg: 17,
    weightDate: "2026-09-01",
    weightUnit: "kg",
    today: "2026-09-02",
    declinedDoseUpdates: [],
  };

  function row(
    over: {
      pediatric?: PediatricFormContext | null;
      doseAmount?: string;
      offerSeat?: boolean;
      profileId?: number;
    } = {}
  ) {
    render(
      <QuickLogPrnControl
        identity={{ name: "Ibuprofen", rxcui: "5640" }}
        itemId={31}
        name="Ibuprofen"
        doseAmount={over.doseAmount ?? "100 mg"}
        dayLabel="None today"
        tz="UTC"
        profileId={over.profileId}
        offerSeat={over.offerSeat}
        pediatric={over.pediatric === undefined ? GROWN : over.pediatric}
      />
    );
  }

  it("states both figures and what each answer does", () => {
    row();
    const offer = screen.getByTestId("offer-dose-band-update");
    expect(offer.textContent).toContain(
      "Ibuprofen is set to 100 mg. Update it to 150 mg?"
    );
    expect(
      screen.getByTestId("offer-accept-dose-band-update").textContent
    ).toBe("Update to 150 mg");
    expect(
      screen.getByTestId("offer-decline-dose-band-update").textContent
    ).toBe("Keep 100 mg");
  });

  it("sits below the band statement, and never in front of the tap", () => {
    row();
    const basis = screen.getByTestId("prn-band-basis");
    const offer = screen.getByTestId("offer-dose-band-update");
    // DOCUMENT_POSITION_FOLLOWING: the offer comes after the statement it answers.
    expect(
      basis.compareDocumentPosition(offer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const take = screen.getByTestId("prn-log-now") as HTMLButtonElement;
    expect(take.disabled).toBe(false);
    expect(take.getAttribute("aria-label")).toBe("Take Ibuprofen · 100 mg");
    fireEvent.click(take);
    expect(mocks.logMedicationAdministration).toHaveBeenCalled();
  });

  it.each([
    {
      subject: "a stored dose that already is the band figure",
      over: { doseAmount: "150 mg" },
    },
    {
      subject: "a figure this subject has declined",
      over: {
        pediatric: {
          ...GROWN,
          declinedDoseUpdates: ["dose-band-update:31:150"],
        },
      },
    },
    {
      subject: "a row that does not hold the surface's one seat",
      over: { offerSeat: false },
    },
    { subject: "an adult profile", over: { pediatric: null } },
  ])("offers nothing for $subject", ({ over }) => {
    row(over);
    expect(screen.queryByTestId("offer-dose-band-update")).toBeNull();
    expect(
      (screen.getByTestId("prn-log-now") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  // The answer follows the SUBJECT, like the dose write beside it: the illness cockpit
  // answers for the household member the row logs for, not the acting login.
  it("answers for the profile the row logs for", async () => {
    row({ profileId: 99 });
    await act(async () =>
      fireEvent.click(screen.getByTestId("offer-decline-dose-band-update"))
    );
    const posted = mocks.declineDoseBandUpdate.mock.calls.at(-1)![0];
    expect(posted.get("dedupe_key")).toBe("dose-band-update:31:150");
    expect(posted.get("profileId")).toBe("99");
  });
});
