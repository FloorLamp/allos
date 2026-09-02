import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import DayLedger from "@/app/(app)/nutrition/DayLedger";
import QuickDoseList from "@/components/quick-entry/QuickDoseList";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import type { LedgerGroup } from "@/lib/day-ledger";

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
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
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
}));
vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  logHistoricalDose: mocks.logHistoricalDose,
  updateHistoricalDose: mocks.updateHistoricalDose,
  setDoseStatus: mocks.setDoseStatus,
  resolveDayDoses: vi.fn(),
}));

const TODAY = "2026-08-28";
const YESTERDAY = "2026-08-27";

const CREATINE = {
  id: 7,
  name: "Creatine",
  asNeeded: false,
  courseBound: false,
  doses: [
    { id: 11, label: "5 g · Morning", amount: "5 g" },
    { id: 12, label: "5 g · Evening", amount: "5 g" },
  ],
};
const MAGNESIUM = {
  id: 8,
  name: "Magnesium",
  asNeeded: false,
  courseBound: false,
  doses: [{ id: 21, label: "200 mg · Before sleep", amount: "200 mg" }],
};

beforeEach(() => {
  posted.length = 0;
  vi.clearAllMocks();
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
});

const DUE_DOSE = {
  doseId: 31,
  itemId: 7,
  name: "Creatine",
  detail: "5 g",
  stack: null,
  bucket: "Morning" as const,
  timeOfDay: "Morning",
};

function ledgerGroups(): LedgerGroup[] {
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
          doses: [DUE_DOSE],
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
          writeMinute: `${YESTERDAY}T08:06`,
        },
      ],
    },
  ];
}

// The bucket's due row is a disclosure; its dose rows — the ones that carry a control
// — only exist once it is open, so a fixture that never expands it can never reach the
// state these assertions are about.
function renderLedger(date: string) {
  const view = render(
    <DayLedger
      date={date}
      groups={ledgerGroups()}
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
  function renderSheet() {
    return render(
      <QuickDoseList
        today={TODAY}
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
                  { doseId: 41, name: "Creatine", detail: "5 g", stack: null },
                ],
              },
            ],
          },
        ]}
        onDone={vi.fn()}
      />
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
});

// THE "EARLIER DOSE" STATEMENT STATES ITS DAY (#4691). The shared PRN row handed the
// WhenControl `minDate === maxDate === today`, which renders the day as fixed TEXT — so
// the illness cockpit could show a Yesterday toggle above a row that could only ever
// write today, and last night's dose had no path from the surface a parent was looking
// at. The claim is the pair: the control OFFERS a real day range, and whatever day it
// is left on is the day the write states.
describe("the PRN row's earlier-dose statement reaches a past day (#4691)", () => {
  // The component reads its own "today" from the UTC zone it is handed, so the test
  // derives the pair the same way rather than pinning a literal that ages out.
  const TODAY_UTC = new Date().toISOString().slice(0, 10);
  const YESTERDAY_UTC = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  function row(): void {
    render(
      <QuickLogPrnControl
        itemId={31}
        name="Ibuprofen"
        doseAmount="200 mg"
        dayLabel="1 today · last 4:02pm"
        tz="UTC"
      />
    );
  }

  async function openStatement(): Promise<void> {
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-more")));
  }

  it("offers a real day field, not the fixed-day text a single pinned day renders", async () => {
    row();
    await openStatement();
    // The WhenControl draws a <span> when minDate === maxDate and the editable
    // DateField otherwise: which ELEMENT is here IS the claim.
    expect(screen.getByTestId("prn-log-when-date").tagName).toBe("INPUT");
  });

  it("posts the stated day beside the stated time", async () => {
    row();
    await openStatement();
    await act(async () =>
      fireEvent.change(screen.getByTestId("prn-log-when-date"), {
        target: { value: YESTERDAY_UTC },
      })
    );
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
          itemId={31}
          name="Ibuprofen"
          doseAmount="200 mg"
          dayLabel="1 today · last 4:02pm"
          tz="UTC"
        />
      </CockpitDayProvider>
    );
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-more")));
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
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-more")));
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

  it("the taken-now tap states no day at all — its action stamps today", async () => {
    row();
    await act(async () => fireEvent.click(screen.getByTestId("prn-log-now")));
    const fd = fields();
    expect(fd.offset).toBe("now");
    expect(fd.date).toBeUndefined();
  });
});
