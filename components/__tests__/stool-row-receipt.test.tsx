import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import StoolTypeControl from "@/components/stool/StoolTypeControl";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import { DayContextProvider } from "@/components/DayContext";
import BoundedDaySwitcher from "@/components/BoundedDaySwitcher";
import { SHEET_REACH } from "@/lib/log-manifest";
import { shiftDateStr } from "@/lib/date";

// THE STOOL SHEET'S RECEIPT ROWS (#5663 ruling 1, and the owner's 2026-09-11 ruling).
//
// The report was "quicklogging stool provides no feedback or description": the tap
// moved a count and toasted a NUMBER, and the sentence that says what the number means
// was reachable only behind the title row's info glyph (#5756) or as an accessible
// name. What is asserted here is the whole of the fix — the sheet lists the DAY, newest
// first, two lines a row carrying the scale's label and its sentence; the ruled count
// line sits beneath; and the `undo: null` that used to be declared here is a real
// inverse that runs.
//
// THE INVERSE IS PICKED BY WHAT THE WRITE DID, which is the half that could quietly be
// wrong: a row's natural key is its instant, so restating a minute CORRECTS the reading
// already there, and deleting it would take away a reading the tap never made.
const {
  toast,
  announce,
  logStoolForm,
  loadStoolDay,
  deleteStoolReading,
  correctStoolReading,
} = vi.hoisted(() => ({
  toast: vi.fn(),
  announce: vi.fn(),
  logStoolForm: vi.fn(),
  loadStoolDay: vi.fn(),
  deleteStoolReading: vi.fn(),
  correctStoolReading: vi.fn(),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => toast }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
  useQueuedDayContextCapture: () => () => null,
}));
vi.mock("@/components/LoggedViaSurface", () => ({
  useLoggedViaStamp: () => (fd: FormData) => fd,
}));
vi.mock("@/components/useUndoableAction", () => ({
  useUndoableAction: () => announce,
}));
vi.mock("@/app/(app)/stool-actions", () => ({
  logStoolForm,
  loadStoolDay,
  deleteStoolReading,
  correctStoolReading,
}));

// A 12-hour login, so a row's trailing slot proves it goes through the display
// preference seam (#964) rather than printing the stored 24-hour spelling.
function renderRow(props: {
  todayCount: number;
  today: string;
  subjectProfileId?: number;
}) {
  return render(
    <FormatPrefsProvider prefs={{ timeFormat: "12h", dateFormat: "mdy" }}>
      <StoolTypeControl {...props} />
    </FormatPrefsProvider>
  );
}

// THE TWO KINDS OF MINUTE A ROW CAN CARRY (#5921), said by the fixture rather than
// left to be inferred. The store has drawn this line since #5915 — a tap with no
// stated time records `occurred_at NULL` — and the action hands it over as
// `clockKind`, so a fixture that omitted it would be describing a row the store
// cannot produce and the row's voice would be an accident.
const stated = (id: number, type: number, hhmm: string) => ({
  id,
  type,
  hhmm,
  clockKind: "stated" as const,
  filedDay: null,
});
// A one-tap row: nobody named the minute, so the only instant it has is the stamp it
// was filed at. `filedDay` is the day that filing fell on, which is what decides
// between "logged 8:31 AM" and "logged Jul 8" (#5618 ruling 6).
const filed = (
  id: number,
  type: number,
  hhmm: string,
  filedDay = "2026-07-08"
) => ({ id, type, hhmm, clockKind: "logged" as const, filedDay });

const rows = () => screen.queryAllByTestId("quick-entry-stool-receipt");
const lines = () =>
  rows().map((row) => [
    within(row).getByTestId("quick-entry-stool-receipt-heading").textContent,
    within(row).getByTestId("quick-entry-stool-receipt-facts").textContent,
  ]);
const count = () =>
  screen.getByTestId("quick-entry-stool-count").textContent ?? "";

async function tap(type: number) {
  await act(async () => {
    screen.getByTestId(`stool-type-${type}`).click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadStoolDay.mockResolvedValue({ readings: [], dayCount: 0 });
});

describe("the sheet lists the day", () => {
  it("states every entry newest first, in the ruled two lines, over the ruled count", async () => {
    loadStoolDay.mockResolvedValue({
      readings: [stated(12, 3, "06:02")],
      dayCount: 1,
    });
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 6,
      dayCount: 2,
      reading: { id: 31 },
      readings: [filed(31, 6, "08:31"), stated(12, 3, "06:02")],
    });
    renderRow({ todayCount: 1, today: "2026-07-08" });

    // THE ROWS PREDATE THE TAP. The sheet's own gather answers with a count, so a row
    // logged earlier today would be invisible until the next tap without this read.
    //
    // AND THE CLOCK IS THE ONE RULED VOICE (#5663 ruling 1, owner 2026-09-15): this is
    // a 12-hour login, so the trailing slot reads `6:02 AM`. It shipped `6:02am` beneath
    // an illness card printing `8:00 AM` on the same screen; the owner ruled the
    // `upper-space` spelling for both rather than a third one.
    await waitFor(() =>
      expect(lines()).toEqual([
        [
          "Type 3 · Cracked",
          "Like a sausage but with cracks on the surface · 6:02 AM",
        ],
      ])
    );

    await tap(6);

    // The ruling's worked example, newest first. The LABEL is on the heading line and
    // the scale's own sentence on the facts line — neither was printed anywhere on
    // this surface before.
    //
    // AND THE TWO ROWS ARE NOT IN THE SAME VOICE (#5921). The tap named no minute, so
    // its clock is the stamp it was filed at and the row says so in #5618 ruling 6's
    // word; the row above it carries a minute somebody stated and stays bare. Before
    // this they were spelled identically, which is the store's own distinction being
    // undone in presentation.
    await waitFor(() =>
      expect(lines()).toEqual([
        [
          "Type 6 · Mushy",
          "Fluffy pieces with ragged edges, a mushy stool · logged 8:31 AM",
        ],
        [
          "Type 3 · Cracked",
          "Like a sausage but with cracks on the surface · 6:02 AM",
        ],
      ])
    );
    // One count line beneath, in the ruled form.
    expect(count()).toBe("2 today");
    // And the toast confirms the same landing, carrying the same Undo. Its `· <time>`
    // slot is a STATED minute and this tap stated none, so the slot drops rather than
    // naming the filing minute as the movement's — the claim #5915 stopped the store
    // making. The row beneath still states it, qualified.
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Type 6 logged",
        undo: expect.objectContaining({ undoneMessage: "Movement removed." }),
      })
    );
  });

  it("offers Undo on the newest row only, and only for a reading this tap landed", async () => {
    loadStoolDay.mockResolvedValue({
      readings: [stated(12, 3, "06:02"), stated(9, 1, "05:10")],
      dayCount: 2,
    });
    renderRow({ todayCount: 2, today: "2026-07-08" });
    await waitFor(() => expect(rows()).toHaveLength(2));

    // GATHERED, NOT LOGGED HERE. #2642's offer rides the write; an Undo beside a
    // reading from three hours ago is a delete wearing the word, and the record's ⋯ is
    // where a delete belongs.
    expect(
      screen.queryAllByTestId("quick-entry-stool-receipt-undo")
    ).toHaveLength(0);

    logStoolForm.mockResolvedValue({
      ok: true,
      type: 5,
      dayCount: 3,
      reading: { id: 44 },
      readings: [
        filed(44, 5, "09:40"),
        stated(12, 3, "06:02"),
        stated(9, 1, "05:10"),
      ],
    });
    await tap(5);

    await waitFor(() => expect(rows()).toHaveLength(3));
    // Exactly one Undo, on the newest row.
    const undos = screen.queryAllByTestId("quick-entry-stool-receipt-undo");
    expect(undos).toHaveLength(1);
    expect(
      within(rows()[0]).getByTestId("quick-entry-stool-receipt-undo")
    ).toBe(undos[0]);

    // …AND IT RUNS THAT ROW'S INVERSE. Two older readings sit beneath it, so a
    // control wired to the list rather than to the reading it belongs to would post
    // one of their ids and quietly remove a movement the person did not just log.
    deleteStoolReading.mockResolvedValue({ undoId: 1 });
    await act(async () => {
      undos[0].click();
    });
    expect(
      (deleteStoolReading.mock.calls.at(-1)?.[0] as FormData).get("id")
    ).toBe("44");
  });

  // THE OTHER HALF OF THE SAME PREDICATE, which the case above cannot reach: there,
  // the reading this mount landed IS the newest row, so "landed" and "newest" are the
  // same row and dropping either conjunct changes nothing. A stated time puts them
  // apart — the tap corrects a reading in the middle of the day while a later one
  // already stands above it.
  it("shows no Undo at all when the reading this tap landed on is not the newest", async () => {
    loadStoolDay.mockResolvedValue({
      readings: [stated(99, 2, "21:15"), stated(44, 3, "12:00")],
      dayCount: 2,
    });
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 5,
      dayCount: 2,
      // The midday reading, corrected from type 3 by restating its minute.
      reading: { id: 44, replacedType: 3 },
      readings: [stated(99, 2, "21:15"), stated(44, 5, "12:00")],
    });
    renderRow({ todayCount: 2, today: "2026-07-08" });
    await waitFor(() => expect(rows()).toHaveLength(2));

    await tap(5);
    await waitFor(() => expect(lines()[1][0]).toBe("Type 5 · Soft blobs"));

    // NOT ON THE NEWEST ROW, because this tap did not write it — an Undo there would
    // be a delete of the 21:15 reading wearing the word, or worse, a control beside
    // the 21:15 row running the 12:00 row's inverse.
    // NOT ON THE LANDED ROW EITHER: the ruling puts the control on the newest row,
    // and #2642's offer rides the write, so when the two are not the same row there
    // is no seat for it. The record's ⋯ is where an older reading is corrected.
    expect(
      screen.queryAllByTestId("quick-entry-stool-receipt-undo")
    ).toHaveLength(0);
    // The toast still carries it — that offer is about the write, not about a row.
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        undo: expect.objectContaining({ undoneMessage: "Type 3 restored." }),
      })
    );
  });

  it("offers nothing to undo when the write added no reading", async () => {
    // Re-tapping the type already at that instant changes nothing the day's rows can
    // show, so the action answers without a reading — and an Undo with nothing behind
    // it is worse than the silence this issue is fixing.
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 4,
      dayCount: 1,
      readings: [stated(12, 4, "06:02")],
    });
    renderRow({ todayCount: 1, today: "2026-07-08" });

    await tap(4);

    // With no Undo to ride, the pipeline's `say` takes the ordinary toast rather than
    // the undoable channel — the same fork the error announcement takes, and the
    // reason a mis-routed sentence is visible here rather than silent.
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Type 4 logged"));
    expect(announce).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(
      screen.queryAllByTestId("quick-entry-stool-receipt-undo")
    ).toHaveLength(0);
  });
});

describe("the Undo the declaration used to refuse", () => {
  it("removes the reading it named and re-reads the day", async () => {
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 6,
      dayCount: 3,
      reading: { id: 77 },
      readings: [
        filed(77, 6, "08:12"),
        stated(12, 3, "06:02"),
        stated(9, 1, "05:10"),
      ],
    });
    deleteStoolReading.mockResolvedValue({ undoId: 500 });
    renderRow({ todayCount: 2, today: "2026-07-08", subjectProfileId: 9 });

    await tap(6);
    await waitFor(() => expect(count()).toBe("3 today"));

    loadStoolDay.mockResolvedValue({
      readings: [stated(12, 3, "06:02"), stated(9, 1, "05:10")],
      dayCount: 2,
    });
    await act(async () => {
      screen.getByTestId("quick-entry-stool-receipt-undo").click();
    });

    // ADDRESSED BY ROW ID AND BY SUBJECT. The id is what the action re-derives against
    // — a stale offer refuses rather than reaching another row — and the subject is
    // the sheet's chosen profile, not whoever is acting.
    const sent = deleteStoolReading.mock.calls.at(-1)?.[0] as FormData;
    expect(sent.get("id")).toBe("77");
    expect(sent.get("profile_id")).toBe("9");
    // THE DAY IS ASKED FOR AGAIN, never spliced: the rows and the count come back
    // together from the store rather than from arithmetic that can disagree with it.
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(count()).toBe("2 today");
    expect(toast).toHaveBeenCalledWith("Movement removed.");
  });

  it("restores the previous type when the tap corrected a reading", async () => {
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 5,
      dayCount: 1,
      reading: { id: 77, replacedType: 3 },
      readings: [stated(77, 5, "08:12")],
    });
    correctStoolReading.mockResolvedValue({ ok: true });
    renderRow({ todayCount: 1, today: "2026-07-08" });

    await tap(5);
    await waitFor(() => expect(rows()).toHaveLength(1));

    loadStoolDay.mockResolvedValue({
      readings: [stated(77, 3, "08:12")],
      dayCount: 1,
    });
    await act(async () => {
      screen.getByTestId("quick-entry-stool-receipt-undo").click();
    });

    // A DELETE WOULD BE THE WRONG INVERSE HERE: the reading at that instant existed
    // before the tap, and taking it away would lose a movement the person logged.
    expect(deleteStoolReading).not.toHaveBeenCalled();
    const sent = correctStoolReading.mock.calls.at(-1)?.[0] as FormData;
    expect(sent.get("id")).toBe("77");
    expect(sent.get("type")).toBe("3");
    await waitFor(() =>
      expect(lines()).toEqual([
        [
          "Type 3 · Cracked",
          "Like a sausage but with cracks on the surface · 8:12 AM",
        ],
      ])
    );
    // Nothing was added, so nothing is taken away.
    expect(count()).toBe("1 today");
    expect(toast).toHaveBeenCalledWith("Type 3 restored.");
  });

  it("says the shared refusal line when the inverse will not run", async () => {
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 6,
      dayCount: 1,
      reading: { id: 77 },
      readings: [filed(77, 6, "08:12")],
    });
    // The action's only refusal shape: the row is gone, not this profile's, or not a
    // Bristol row at all.
    deleteStoolReading.mockResolvedValue({ undoId: null });
    renderRow({ todayCount: 0, today: "2026-07-08" });

    await tap(6);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(async () => {
      screen.getByTestId("quick-entry-stool-receipt-undo").click();
    });

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Couldn’t undo — this has changed since.",
        { tone: "error" }
      )
    );
    // The row STAYS: nothing came back, so the sheet still describes the reading that
    // is still there.
    expect(rows()).toHaveLength(1);
    expect(count()).toBe("1 today");
  });
});

describe("a sheet showing the day shows ONE person's day", () => {
  it("drops the rows and re-reads when it is re-pointed at another person", async () => {
    loadStoolDay.mockResolvedValue({
      readings: [stated(12, 3, "06:02")],
      dayCount: 1,
    });
    const { rerender } = render(
      <FormatPrefsProvider prefs={{ timeFormat: "12h", dateFormat: "mdy" }}>
        <StoolTypeControl
          todayCount={1}
          today="2026-07-08"
          subjectProfileId={4}
        />
      </FormatPrefsProvider>
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(
      (loadStoolDay.mock.calls.at(-1)?.[0] as FormData).get("profile_id")
    ).toBe("4");

    loadStoolDay.mockResolvedValue({ readings: [], dayCount: 0 });
    rerender(
      <FormatPrefsProvider prefs={{ timeFormat: "12h", dateFormat: "mdy" }}>
        <StoolTypeControl
          todayCount={0}
          today="2026-07-08"
          subjectProfileId={5}
        />
      </FormatPrefsProvider>
    );

    // A shared sheet must never print a row about another person's reading, so the
    // rows go at the moment the subject changes rather than when the new read lands.
    expect(rows()).toHaveLength(0);
    await waitFor(() =>
      expect(
        (loadStoolDay.mock.calls.at(-1)?.[0] as FormData).get("profile_id")
      ).toBe("5")
    );
  });
});

// THE COUNT LINE TAKES THE DAY SWITCHER'S OWN WORD (#5663 ruling 5, owner 2026-09-15).
//
// `count` counts `writeDate` — the day the sheet is POINTED AT — while the line read a
// hard-coded `N today`, so standing on Yesterday the sheet said "1 today" directly under
// rows naming yesterday's clock times. Two statements about one day, on one screen,
// disagreeing. The ruled word is the one `BoundedDaySwitcher` is already showing on the
// selected tab, and never "today" for a past day.
//
// THE SWITCHER IS MOUNTED BESIDE THE CONTROL HERE, which is the point of the case: the
// earlier-day arm asserts the line against the label the tab is actually rendering
// rather than against a weekday string written out below. A literal would pin today's
// spelling of that label and go red the day the switcher's own wording moves — which is
// exactly the drift this ruling exists to close.
describe("the count line's day word", () => {
  const today = "2026-07-08";
  const sheetOn = (day: string) =>
    render(
      <FormatPrefsProvider prefs={{ timeFormat: "12h", dateFormat: "mdy" }}>
        <DayContextProvider
          profileId={7}
          today={today}
          reach={SHEET_REACH}
          backing={{ kind: "state", initialDay: day }}
        >
          <BoundedDaySwitcher />
          <StoolTypeControl todayCount={1} today={today} />
        </DayContextProvider>
      </FormatPrefsProvider>
    );

  beforeEach(() => {
    loadStoolDay.mockResolvedValue({
      readings: [stated(12, 3, "06:02")],
      dayCount: 1,
    });
  });

  it("says today on today", async () => {
    sheetOn(today);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(count()).toBe("1 today");
  });

  it("says yesterday on yesterday, never today", async () => {
    sheetOn(shiftDateStr(today, -1));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(count()).toBe("1 yesterday");
  });

  it("names an earlier day with the label its own tab is showing", async () => {
    const earlier = shiftDateStr(today, -2);
    sheetOn(earlier);
    await waitFor(() => expect(rows()).toHaveLength(1));

    const tab = screen.getByTestId("day-context-2").textContent;
    expect(tab).toBeTruthy();
    expect(tab).not.toMatch(/today|yesterday/i);
    expect(count()).toBe(`1 on ${tab}`);
  });
});

// THE RECEIPT SAYS WHICH MINUTE IT IS NAMING (#5921), on a day that is not today.
//
// The sharper half of the defect: standing on Yesterday, a row filed THIS MORNING with
// no stated time printed `4:19 AM` beside a genuinely stated `8:10 AM`. The minute is
// true of no minute of the day the reader is looking at, and the record already called
// that same row "logged Sep 16". #5618 ruling 6 settles it — the filing DAY, no clock —
// and the owner ruled on 2026-09-10 that the rule belongs to the clock grammar rather
// than to one page, which is why this asks the same `historyClock` the record asks.
//
// THE SWITCHER IS MOUNTED BESIDE THE CONTROL for the same reason the count-line cases
// mount it: the sheet's day comes from the day context, and a case that faked it would
// not be standing where the person is.
describe("a receipt row on a past day", () => {
  const today = "2026-07-08";
  const yesterday = shiftDateStr(today, -1);
  const sheetOn = (day: string) =>
    render(
      <FormatPrefsProvider prefs={{ timeFormat: "12h", dateFormat: "mdy" }}>
        <DayContextProvider
          profileId={7}
          today={today}
          reach={SHEET_REACH}
          backing={{ kind: "state", initialDay: day }}
        >
          <BoundedDaySwitcher />
          <StoolTypeControl todayCount={2} today={today} />
        </DayContextProvider>
      </FormatPrefsProvider>
    );

  it("names the day it was filed on, never a minute from another day", async () => {
    loadStoolDay.mockResolvedValue({
      // Filed today, counted under yesterday, with nobody having named a minute.
      readings: [filed(30, 5, "04:19", today), stated(31, 3, "08:10")],
      dayCount: 2,
    });
    sheetOn(yesterday);

    await waitFor(() =>
      expect(lines()).toEqual([
        [
          "Type 5 · Soft blobs",
          "Soft blobs with clear-cut edges, passed easily · logged Jul 8",
        ],
        [
          "Type 3 · Cracked",
          "Like a sausage but with cracks on the surface · 8:10 AM",
        ],
      ])
    );
    // No row prints a clock that belongs to a different day than the one beneath it.
    for (const [, facts] of lines()) expect(facts).not.toMatch(/\b4:19\b/);
  });

  it("keeps the minute when the filing fell on the day the row sits under", async () => {
    loadStoolDay.mockResolvedValue({
      readings: [filed(30, 5, "04:19", yesterday)],
      dayCount: 1,
    });
    sheetOn(yesterday);

    // Same-day filing keeps the clock — it is about the day the reader is looking at
    // and it orders the row against its neighbours. Only the WORD marks it.
    await waitFor(() =>
      expect(lines()).toEqual([
        [
          "Type 5 · Soft blobs",
          "Soft blobs with clear-cut edges, passed easily · logged 4:19 AM",
        ],
      ])
    );
  });
});
