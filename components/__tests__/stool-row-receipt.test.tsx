import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import StoolTypeControl from "@/components/stool/StoolTypeControl";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";

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
      readings: [{ id: 12, type: 3, hhmm: "06:02" }],
      dayCount: 1,
    });
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 6,
      dayCount: 2,
      reading: { id: 31 },
      readings: [
        { id: 31, type: 6, hhmm: "08:31" },
        { id: 12, type: 3, hhmm: "06:02" },
      ],
    });
    renderRow({ todayCount: 1, today: "2026-07-08" });

    // THE ROWS PREDATE THE TAP. The sheet's own gather answers with a count, so a row
    // logged earlier today would be invisible until the next tap without this read.
    await waitFor(() =>
      expect(lines()).toEqual([
        [
          "Type 3 · Cracked",
          "Like a sausage but with cracks on the surface · 6:02am",
        ],
      ])
    );

    await tap(6);

    // The ruling's worked example, newest first. The LABEL is on the heading line and
    // the scale's own sentence on the facts line — neither was printed anywhere on
    // this surface before.
    await waitFor(() =>
      expect(lines()).toEqual([
        [
          "Type 6 · Mushy",
          "Fluffy pieces with ragged edges, a mushy stool · 8:31am",
        ],
        [
          "Type 3 · Cracked",
          "Like a sausage but with cracks on the surface · 6:02am",
        ],
      ])
    );
    // One count line beneath, in the ruled form.
    expect(count()).toBe("2 today");
    // And the toast confirms the same landing, carrying the same Undo.
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Type 6 logged · 8:31am",
        undo: expect.objectContaining({ undoneMessage: "Movement removed." }),
      })
    );
  });

  it("offers Undo on the newest row only, and only for a reading this tap landed", async () => {
    loadStoolDay.mockResolvedValue({
      readings: [
        { id: 12, type: 3, hhmm: "06:02" },
        { id: 9, type: 1, hhmm: "05:10" },
      ],
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
        { id: 44, type: 5, hhmm: "09:40" },
        { id: 12, type: 3, hhmm: "06:02" },
        { id: 9, type: 1, hhmm: "05:10" },
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
  });

  it("offers nothing to undo when the write added no reading", async () => {
    // Re-tapping the type already at that instant changes nothing the day's rows can
    // show, so the action answers without a reading — and an Undo with nothing behind
    // it is worse than the silence this issue is fixing.
    logStoolForm.mockResolvedValue({
      ok: true,
      type: 4,
      dayCount: 1,
      readings: [{ id: 12, type: 4, hhmm: "06:02" }],
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
        { id: 77, type: 6, hhmm: "08:12" },
        { id: 12, type: 3, hhmm: "06:02" },
        { id: 9, type: 1, hhmm: "05:10" },
      ],
    });
    deleteStoolReading.mockResolvedValue({ undoId: 500 });
    renderRow({ todayCount: 2, today: "2026-07-08", subjectProfileId: 9 });

    await tap(6);
    await waitFor(() => expect(count()).toBe("3 today"));

    loadStoolDay.mockResolvedValue({
      readings: [
        { id: 12, type: 3, hhmm: "06:02" },
        { id: 9, type: 1, hhmm: "05:10" },
      ],
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
      readings: [{ id: 77, type: 5, hhmm: "08:12" }],
    });
    correctStoolReading.mockResolvedValue({ ok: true });
    renderRow({ todayCount: 1, today: "2026-07-08" });

    await tap(5);
    await waitFor(() => expect(rows()).toHaveLength(1));

    loadStoolDay.mockResolvedValue({
      readings: [{ id: 77, type: 3, hhmm: "08:12" }],
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
          "Like a sausage but with cracks on the surface · 8:12am",
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
      readings: [{ id: 77, type: 6, hhmm: "08:12" }],
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
      readings: [{ id: 12, type: 3, hhmm: "06:02" }],
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
