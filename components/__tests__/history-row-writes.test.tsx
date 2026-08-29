import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HistoryRows from "@/app/(app)/history/HistoryRows";
import { bodyMetricMeasures } from "@/lib/body-metric-measures";
import type { HistoryRow } from "@/lib/history-format";

// WHAT THE RECORD'S ⋯ ACTUALLY POSTS (#3958, after the #4016 falsifying pass).
//
// THE GAP THIS CLOSES, stated plainly because it is the whole reason the file exists:
// `/history` shipped 322 lines of e2e covering grouping, geometry, the chrome budget,
// its doors and its degrade paths, and NEVER OPENED THE ⋯ MENU. Five write paths, no
// test on any of them. Two of the four defects that pass found were wrong VALUES in
// the payload — not nulls, so reading the forms did not catch them either:
//
//   • practice posted `row.sortTime`, which is `bestKnownInstant` and falls back to
//     `created_at`, so correcting a DURATION laundered the filing clock into the
//     event column (#2205's substitution, in the one place the page claims to prevent
//     it);
//   • body posted the STORED kilograms with `weight_unit: lb` beside them, so a row
//     reading "154.3 lb" opened its editor on 70 and saving it unchanged rewrote the
//     record to 31.75 kg.
//
// WHY THIS TIER. What each ACTION does with a payload is already driven at the action
// tier; what the gather HANDS the row is driven at the DB tier
// (lib/__db_tests__/history-gather.test.ts). The half nobody had is the one in
// between — what the mounted form puts in the FormData — and it only exists once
// something is rendered. Every assertion below is on the payload the domain's own
// Server Action was HANDED, never on what the form meant to send.
//
// NO NEW WRITE PATHS is asserted structurally: the mocks below are the ten actions
// that already existed — five corrections and five deletes. A sixth domain reaching
// this component would post to something unmocked and fail here rather than quietly
// ship.
//
// THAT SENTENCE WAS FALSE FOR THE DELETE HALF UNTIL THE SECOND PASS, and it is worth
// keeping the correction visible: `useUndoableDelete` was mocked to a no-op, so the
// four `undoable(action, fd, …)` call sites were never invoked and all five delete
// payloads were uncovered — corrupting every one of them to junk left this file green.
// A mock that stands in for a hook has to DO what the hook does with its arguments, or
// the coverage it appears to give is coverage of the mock.

/** Every payload each domain action was handed, by action name. */
const posted: Record<string, FormData[]> = {};
const record = (name: string) => (fd: FormData) => {
  (posted[name] ??= []).push(fd);
  return name;
};

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  deleteAdministration: async (fd: FormData) => {
    record("deleteAdministration")(fd);
    return { undoId: 1 };
  },
  logHistoricalDose: async () => ({ ok: true }),
  updateHistoricalDose: async (fd: FormData) => {
    record("updateHistoricalDose")(fd);
    return { ok: true };
  },
}));
vi.mock("@/app/(app)/nutrition/actions", () => ({
  updateFoodLogEvent: async (fd: FormData) => {
    record("updateFoodLogEvent")(fd);
    return { ok: true };
  },
  deleteFoodLogEvent: async (fd: FormData) => {
    record("deleteFoodLogEvent")(fd);
    return { ok: true, undoId: 1 };
  },
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  editPracticeSession: async (fd: FormData) => {
    record("editPracticeSession")(fd);
    return { kind: "updated" };
  },
  removePracticeSession: async (fd: FormData) => {
    record("removePracticeSession")(fd);
    return { undoId: 1 };
  },
}));
vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  updateSubstanceDailyTotalAction: async (fd: FormData) => {
    record("updateSubstanceDailyTotalAction")(fd);
    return { kind: "updated" };
  },
  deleteSubstanceDailyTotalAction: async (fd: FormData) => {
    record("deleteSubstanceDailyTotalAction")(fd);
    return { kind: "deleted", undoId: 1 };
  },
}));
vi.mock("@/app/(app)/trends/reading-actions", () => ({
  updateMetricReading: async (fd: FormData) => {
    record("updateMetricReading")(fd);
    return { ok: true };
  },
  deleteMetricReading: async (fd: FormData) => {
    record("deleteMetricReading")(fd);
    return { undoId: 1 };
  },
}));

// The row's neighbours: none of them decides what a correction means.
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
  useConfirmOpen: () => false,
  useOptionalConfirm: () => null,
}));
// THE DELETE HALF HAS TO GO THROUGH, NOT AROUND. This mocked to a no-op, so the four
// `undoable(action, fd, …)` call sites were never invoked and ALL FIVE delete payloads
// were uncovered — corrupting every one of them to junk left the file green. The real
// hook takes the action and the FormData and calls it; so does this, which is the only
// version of it that can see a wrong id.
vi.mock("@/components/useUndoableDelete", () => ({
  useUndoableDelete:
    () =>
    async (
      action: (fd: FormData) => Promise<unknown>,
      fd: FormData
    ): Promise<void> => {
      await action(fd);
    },
}));
vi.mock("@/components/FormatPrefsProvider", () => ({
  useFormatPrefs: () => ({ timeFormat: "24h", dateFormat: "iso" }),
}));
vi.mock("@/components/TimezoneProvider", () => ({
  useTimezone: () => "UTC",
}));

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const ACTING = 7;
// A WRITABLE MEMBER WHO IS NOT THE ACTING PROFILE, and their zone and their today.
// Everything above this line renders acting-profile rows, so `profile_id` could only
// ever be compared against ACTING and `row.tz` was never set at all (the fixture cast
// past a required field) — which is why stamping `writableProfileIds[0]` instead of
// the row's own id, and dropping the subject's zone, both passed. Pacific/Niue is
// UTC−11 while the mocked provider says UTC, and their days differ too: a caregiver in
// UTC on 2026-08-28 is a member in Niue still on 2026-08-27.
const MEMBER = 11;
const MEMBER_TZ = "Pacific/Niue";
const ACTING_TODAY = "2026-08-28";
const MEMBER_TODAY = "2026-08-27";

function row(over: Partial<HistoryRow> & Pick<HistoryRow, "id" | "kind">) {
  return {
    profileId: ACTING,
    tz: "UTC",
    date: "2026-08-18",
    sortTime: null,
    clock: null,
    clockKind: "stated" as const,
    title: "A row",
    href: null,
    detail: "",
    media: 0,
    edit: null,
    ...over,
  } as HistoryRow;
}

function openRow(
  rows: HistoryRow[],
  writableProfileIds: number[] = [ACTING]
): void {
  cleanup();
  render(
    <HistoryRows
      rows={rows}
      writableProfileIds={writableProfileIds}
      doseItems={[
        {
          id: 42,
          name: "Magnesium",
          kind: "supplement",
          product: null,
          asNeeded: false,
          doses: [{ id: 9, amount: "3 g", time_of_day: "Morning" }],
        },
      ]}
      maxDates={{ [ACTING]: ACTING_TODAY, [MEMBER]: MEMBER_TODAY }}
      defaultTime="09:00"
      subjectNames={{}}
    />
  );
}

async function openEdit(
  rows: HistoryRow[],
  writableProfileIds?: number[]
): Promise<void> {
  openRow(rows, writableProfileIds);
  fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
  await act(async () =>
    fireEvent.click(screen.getByTestId("history-row-edit"))
  );
}

function only(action: string): Record<string, string> {
  const all = posted[action] ?? [];
  expect(all, `${action} was handed ${all.length} payloads`).toHaveLength(1);
  return Object.fromEntries(
    [...all[0].entries()].map(([k, v]) => [k, String(v)])
  );
}

describe("the record's ⋯ posts to the domain's own action", () => {
  it("practice sends the STORED session time, never the clock its row fell back to", async () => {
    // The shape the defect lived in: a quick-path tick with NO stated time, whose row
    // therefore carries the record chain's minute and says "logged" about it.
    await openEdit([
      row({
        id: "practice:5",
        kind: "practice",
        sortTime: "19:43",
        clock: "logged 19:43",
        clockKind: "logged",
        title: "Breathwork",
        edit: {
          kind: "practice",
          sessionId: 5,
          statedTime: null,
          durationMin: null,
          notes: "evening wind-down",
        },
      }),
    ]);
    fireEvent.change(screen.getByLabelText("Duration (minutes)"), {
      target: { value: "25" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );

    const fd = only("editPracticeSession");
    expect(fd.id).toBe("5");
    expect(fd.duration_min).toBe("25");
    // THE ASSERTION THE DEFECT FAILS: 19:43 is on screen, and it must not be in the
    // payload. `editPracticeSession` writes what it is handed, so this is the whole
    // difference between "logged 19:43" and a session claiming to have happened then.
    expect(fd.time).toBe("");
    expect(fd.time).not.toBe("19:43");
    // And the fields the action rewrites from what it reads are still carried, so a
    // duration correction cannot clear the note.
    expect(fd.notes).toBe("evening wind-down");
  });

  it("practice carries a stated time back unchanged", async () => {
    await openEdit([
      row({
        id: "practice:6",
        kind: "practice",
        sortTime: "07:15",
        clock: "07:15",
        title: "Sauna",
        edit: {
          kind: "practice",
          sessionId: 6,
          statedTime: "07:15",
          durationMin: 20,
          notes: null,
        },
      }),
    ]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );
    expect(only("editPracticeSession").time).toBe("07:15");
  });

  it.each(["kg", "lb"] as const)(
    "body sends the %s value the row printed, with the unit it printed it in",
    async (unit) => {
      // Built through the SHARED fan-out the gather uses, so this cannot pass over a
      // page that went back to hand-rolling its own measures.
      const [measure] = bodyMetricMeasures(
        { id: 3, weight_kg: 70, body_fat_pct: null, resting_hr: null },
        unit
      );
      await openEdit([
        row({
          id: "body:weight_kg:3",
          kind: "body",
          title: "Weight",
          detail: `${measure.value}${measure.unit}`,
          edit: {
            kind: "body",
            target: measure.target,
            slug: "weight",
            value: measure.value,
            unit,
          },
        }),
      ]);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Save" }))
      );

      const fd = only("updateMetricReading");
      expect(fd.kind).toBe("weight");
      expect(fd.target).toBe("body_metrics:3:weight_kg");
      // THE ASSERTION THE DEFECT FAILS: saving an UNTOUCHED form must post the number
      // the reader was looking at, in the unit the row printed. Posting the stored 70
      // beside `weight_unit=lb` is what rewrote 70 kg to 31.75 kg.
      expect(fd.weight_unit).toBe(unit);
      expect(Number(fd.value)).toBeCloseTo(measure.value, 6);
      expect(`${fd.value}${measure.unit}`).toBe(
        // and it is the same string the row put on screen
        `${measure.value}${measure.unit}`
      );
    }
  );

  it("food sends its identity and re-anchors a stated eating time when the day moves", async () => {
    await openEdit([
      row({
        id: "food:11",
        kind: "food",
        sortTime: "08:46",
        clock: "08:46",
        title: "Berries",
        edit: {
          kind: "food",
          eventId: 11,
          groupKey: "berries",
          mealSlot: "Morning",
          clock: "08:46",
          clockKind: "stated",
        },
      }),
    ]);
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-08-19" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );

    const fd = only("updateFoodLogEvent");
    expect(fd.event_id).toBe("11");
    expect(fd.date).toBe("2026-08-19");
    expect(fd.group_key).toBe("berries");
    expect(fd.meal_slot).toBe("Morning");
    // MOVING A SERVING MOVES THE (DAY, WALL-TIME) PAIR — the contract the deleted
    // `foodLedgerOccurredAtPatch` owned, and the one thing this reinstatement had no
    // test for. Without it a stated eating instant is stranded on the old day.
    expect(fd.occurred_at).toBe("08:46");
  });

  it("food omits the instant patch when the day did not move", async () => {
    await openEdit([
      row({
        id: "food:12",
        kind: "food",
        title: "Berries",
        edit: {
          kind: "food",
          eventId: 12,
          groupKey: "berries",
          mealSlot: "Morning",
          clock: "08:46",
          clockKind: "stated",
        },
      }),
    ]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );
    // An unchanged row omits the patch so its stored second precision is untouched.
    expect(only("updateFoodLogEvent").occurred_at).toBeUndefined();
  });

  it("food invents no eating time for a row that never stated one", async () => {
    await openEdit([
      row({
        id: "food:13",
        kind: "food",
        title: "Berries",
        edit: {
          kind: "food",
          eventId: 13,
          groupKey: "berries",
          mealSlot: "Morning",
          clock: "12:01",
          clockKind: "logged",
        },
      }),
    ]);
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-08-19" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );
    // A logged-at-only row has no eating-time STATEMENT to move (#2019): re-anchoring
    // its filing clock would be the same substitution the practice row shipped.
    expect(only("updateFoodLogEvent").occurred_at).toBeUndefined();
  });

  it("substance carries every field its action rewrites", async () => {
    await openEdit([
      row({
        id: "substance:nicotine:4",
        kind: "substance",
        title: "Nicotine",
        edit: {
          kind: "substance",
          rowId: 4,
          substance: "nicotine",
          amount: 3,
          notes: "after lunch",
        },
      }),
    ]);
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "5" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    );

    const fd = only("updateSubstanceDailyTotalAction");
    expect(fd.substance).toBe("nicotine");
    expect(fd.id).toBe("4");
    expect(fd.amount).toBe("5");
    expect(fd.date).toBe("2026-08-18");
    // `historyInput` stores what it reads, so a form without this field cleared it.
    expect(fd.notes).toBe("after lunch");
  });

  it("dose amends through the domain's own form, seeded from the STATED instant", async () => {
    await openEdit([
      row({
        id: "dose:21",
        kind: "dose",
        sortTime: "10:07",
        clock: "10:07",
        title: "Magnesium",
        edit: {
          kind: "dose",
          logId: 21,
          itemId: 42,
          doseId: 9,
          statedAt: "2026-08-18 10:07:00",
          amount: "3 g",
          itemKind: "supplement",
        },
      }),
    ]);
    // The domain's own component, not a copy: #2228's amend contract lives in it.
    expect(screen.getByTestId("historical-dose-form")).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    );

    const fd = only("updateHistoricalDose");
    expect(fd.log_id).toBe("21");
    expect(fd.id).toBe("42");
    expect(fd.date).toBe("2026-08-18");
    // The row's STATED instant and nothing else (#2228 decision 1): a dose whose
    // clock came from the record chain seeds an EMPTY time rather than laundering it.
    expect(fd.time).toBe("10:07");
  });

  it("seeds no time at all for a dose nobody stated one for", async () => {
    await openEdit([
      row({
        id: "dose:22",
        kind: "dose",
        sortTime: "07:02",
        clock: "logged 07:02",
        clockKind: "logged",
        title: "Magnesium",
        edit: {
          kind: "dose",
          logId: 22,
          itemId: 42,
          doseId: 9,
          statedAt: null,
          amount: "3 g",
          itemKind: "supplement",
        },
      }),
    ]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    );
    // 07:02 is on screen and must not be in the payload — the same claim the practice
    // case makes, on the kind that already got it right.
    expect(only("updateHistoricalDose").time).toBe("");
  });

  // ── EVERY PREFILL, NOT JUST THE FIELD THE CASE CHANGES ──────────────────────
  //
  // The erasure class this PR already fixed twice: these actions REWRITE every field
  // they read, so a form that omits one — or drops its `defaultValue` — clears it, and
  // correcting a note wipes a duration. Cases that change one field and assert that
  // one field cannot see it: deleting `defaultValue={edit.durationMin ?? ""}` passed
  // all three tiers.
  //
  // SO THE ASSERTION IS THE WHOLE PAYLOAD OF AN UNTOUCHED SUBMIT. Open the editor,
  // change nothing, save: every value the action receives must be the value the row
  // already held. A dropped prefill moves one of them and there is nowhere to hide.
  it.each([
    [
      "practice",
      row({
        id: "practice:5",
        kind: "practice",
        date: "2026-08-18",
        title: "Breathwork",
        edit: {
          kind: "practice",
          sessionId: 5,
          statedTime: "07:15",
          durationMin: 25,
          notes: "evening wind-down",
        },
      }),
      "editPracticeSession",
      {
        id: "5",
        date: "2026-08-18",
        time: "07:15",
        duration_min: "25",
        notes: "evening wind-down",
      },
      "Save",
    ],
    [
      "substance",
      row({
        id: "substance:nicotine:4",
        kind: "substance",
        date: "2026-08-18",
        title: "Nicotine",
        edit: {
          kind: "substance",
          rowId: 4,
          substance: "nicotine",
          amount: 3,
          notes: "after lunch",
        },
      }),
      "updateSubstanceDailyTotalAction",
      {
        id: "4",
        substance: "nicotine",
        date: "2026-08-18",
        amount: "3",
        notes: "after lunch",
      },
      "Save",
    ],
    [
      "food",
      row({
        id: "food:11",
        kind: "food",
        date: "2026-08-18",
        title: "Leafy greens",
        edit: {
          kind: "food",
          eventId: 11,
          groupKey: "leafy_greens",
          mealSlot: "Midday",
          clock: "12:30",
          clockKind: "stated",
        },
      }),
      "updateFoodLogEvent",
      {
        event_id: "11",
        date: "2026-08-18",
        group_key: "leafy_greens",
        meal_slot: "Midday",
      },
      "Save",
    ],
    [
      "body",
      row({
        id: "body:resting_hr:3",
        kind: "body",
        title: "Resting Heart Rate",
        edit: {
          kind: "body",
          target: "body_metrics:3:resting_hr",
          slug: "resting-hr",
          value: 54,
          unit: "",
        },
      }),
      "updateMetricReading",
      { kind: "resting-hr", target: "body_metrics:3:resting_hr", value: "54" },
      "Save",
    ],
    [
      // THE KIND THE MATRIX SKIPPED, and the one carrying a VALUE rather than a null.
      // Dose submits through the domain's own `HistoricalDoseForm` — button "Save
      // changes", not "Save" — so it sat outside this table while its two cases
      // asserted only ids and the clock. Nothing asserted that `HistoryRows` forwards
      // `edit.amount` into that form, and the form falls back to
      // `initialDose?.amount` when it is missing: for a TAPER, whose log carries
      // 250 mg against a schedule of 500 mg, the row says 250 and the editor opens on
      // 500, and the historical-dose core writes `amountOverride || row.dose_amount`.
      // Dropping the forwarding was green across 24,476 tests.
      "dose",
      row({
        id: "dose:21",
        kind: "dose",
        date: "2026-08-18",
        title: "Magnesium",
        edit: {
          kind: "dose",
          logId: 21,
          itemId: 42,
          doseId: 9,
          statedAt: "2026-08-18 10:07:00",
          amount: "250 mg",
          itemKind: "supplement",
        },
      }),
      "updateHistoricalDose",
      {
        log_id: "21",
        id: "42",
        dose_id: "9",
        date: "2026-08-18",
        time: "10:07",
        // THE LOG'S OWN AMOUNT, not the schedule's default — the taper, preserved.
        amount: "250 mg",
      },
      "Save changes",
    ],
  ] as const)(
    "%s posts every field back unchanged when nothing was edited",
    async (_kind, item, action, expected, saveLabel) => {
      await openEdit([item]);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: saveLabel }))
      );
      // EVERY CORRECTION NAMES ITS SUBJECT (#4009 item 1), asserted here as ONE
      // invariant over the table rather than as a `profile_id` line repeated into
      // five literal payloads — the fields above stay a statement about what each
      // DOMAIN parses, and this stays a statement about what the page adds. Both
      // halves matter: `gateItemProfile` reads `profile_id` and falls back to the
      // acting-profile gate when it is absent, so a form that forgot to post it
      // would keep working on every single-view page and silently write to the
      // wrong subject on `?view=everyone` — green here, wrong in the one mode the
      // field exists for. Stamped on the acting profile's rows too, so there is no
      // branch that could be right on one side and wrong on the other.
      expect(only(action)).toEqual({
        ...expected,
        profile_id: String(ACTING),
      });
    }
  );

  // ── THE DELETE HALF ─────────────────────────────────────────────────────────
  //
  // Five paths, five payloads, and each names the row by the ids ITS action parses.
  // A delete that reached the wrong row would be the worst of the write defects and
  // was the least covered: the undoable-delete hook was mocked to a no-op, so none of
  // these was ever posted. The `undoId` each action answers with is the shared
  // undoable contract (owner ruling 2026-08-05); what is asserted here is the request.
  it.each([
    [
      "dose",
      row({
        id: "dose:21",
        kind: "dose",
        title: "Magnesium",
        edit: {
          kind: "dose",
          logId: 21,
          itemId: 42,
          doseId: 9,
          statedAt: null,
          amount: "3 g",
          itemKind: "supplement",
        },
      }),
      "deleteAdministration",
      { log_id: "21" },
    ],
    [
      "food",
      row({
        id: "food:11",
        kind: "food",
        title: "Berries",
        edit: {
          kind: "food",
          eventId: 11,
          groupKey: "berries",
          mealSlot: "Morning",
          clock: null,
          clockKind: "logged",
        },
      }),
      "deleteFoodLogEvent",
      { event_id: "11" },
    ],
    [
      "practice",
      row({
        id: "practice:5",
        kind: "practice",
        title: "Breathwork",
        edit: {
          kind: "practice",
          sessionId: 5,
          statedTime: null,
          durationMin: null,
          notes: null,
        },
      }),
      "removePracticeSession",
      { id: "5" },
    ],
    [
      "substance",
      row({
        id: "substance:nicotine:4",
        kind: "substance",
        title: "Nicotine",
        edit: {
          kind: "substance",
          rowId: 4,
          substance: "nicotine",
          amount: 3,
          notes: null,
        },
      }),
      "deleteSubstanceDailyTotalAction",
      { id: "4", substance: "nicotine" },
    ],
    [
      "body",
      row({
        id: "body:weight_kg:3",
        kind: "body",
        title: "Weight",
        edit: {
          kind: "body",
          target: "body_metrics:3:weight_kg",
          slug: "weight",
          value: 70,
          unit: "kg",
        },
      }),
      "deleteMetricReading",
      { kind: "weight", target: "body_metrics:3:weight_kg" },
    ],
  ] as const)(
    "%s deletes by the ids its own action parses",
    async (_kind, item, action, expected) => {
      await openRow([item]);
      fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
      await act(async () =>
        fireEvent.click(screen.getByTestId("history-row-delete"))
      );
      // The same subject invariant as the correction half, and `toEqual` rather
      // than `toMatchObject` so a payload that stopped naming its subject is
      // visible here — a partial match cannot see a missing field.
      expect(only(action)).toEqual({
        ...expected,
        profile_id: String(ACTING),
      });
    }
  );

  // ── A WRITABLE MEMBER'S ROW ─────────────────────────────────────────────────
  //
  // THE GAP THE TABLES ABOVE CANNOT SEE, and the reason it stayed open: every row
  // they render belongs to ACTING and every payload is compared against ACTING, so
  // the three things this page reads OFF THE ROW were only ever checked against the
  // acting profile's own values. All three then survived a mutation.
  //
  //   • `profile_id`  — stamping `writableProfileIds[0] ?? row.profileId` (the first
  //     profile this login may write, instead of the row's) passed every tier.
  //   • the subject's ZONE — `tz` was never set on the fixture rows at all, so
  //     dropping `tz={row.tz}` fell back to the provider and matched.
  //   • the subject's TODAY — one acting-profile `maxDate` bounded a member in a
  //     zone ahead out of their own current day.
  //
  // One writable member, one row of theirs, all three read back. MEMBER is deliberately
  // NOT first in `writableProfileIds`, so "the row's profile" and "a profile this login
  // may write" are different answers.
  const memberDoseRow = () =>
    row({
      id: "dose:77",
      kind: "dose",
      profileId: MEMBER,
      tz: MEMBER_TZ,
      date: "2026-08-18",
      title: "Magnesium",
      edit: {
        kind: "dose",
        logId: 77,
        itemId: 42,
        doseId: 9,
        // 20:30Z on the 18th is 09:30 on the SUBJECT's 18th, and 20:30 on the
        // caregiver's. Both are that day, so only the CLOCK tells the two apart.
        statedAt: "2026-08-18 20:30:00",
        amount: "250 mg",
        itemKind: "supplement",
      },
    });

  it("corrects a writable member's row on THAT member and THEIR clock", async () => {
    await openEdit([memberDoseRow()], [ACTING, MEMBER]);
    // Read BEFORE saving: the form unmounts on success. `DateField` is a text input
    // that enforces its window through the Constraint Validation API, so the bound is
    // observable only by TYPING across it — and asserted as the difference between two
    // real days rather than against a constant, because a field with no bound at all
    // accepts both. The member's own today is accepted; the caregiver's, one day
    // later, is not.
    const dateInput = screen.getByTestId("historical-dose-date");
    fireEvent.change(dateInput, { target: { value: MEMBER_TODAY } });
    expect((dateInput as HTMLInputElement).validationMessage).toBe("");
    fireEvent.change(dateInput, { target: { value: ACTING_TODAY } });
    expect((dateInput as HTMLInputElement).validationMessage).toBe(
      "Date is outside the allowed range."
    );
    fireEvent.change(dateInput, { target: { value: "2026-08-18" } });

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    );
    expect(only("updateHistoricalDose")).toEqual({
      log_id: "77",
      id: "42",
      dose_id: "9",
      date: "2026-08-18",
      time: "09:30",
      amount: "250 mg",
      profile_id: String(MEMBER),
    });
  });

  it("deletes a writable member's row on THAT member", async () => {
    openRow([memberDoseRow()], [ACTING, MEMBER]);
    fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
    await act(async () =>
      fireEvent.click(screen.getByTestId("history-row-delete"))
    );
    expect(only("deleteAdministration")).toEqual({
      log_id: "77",
      profile_id: String(MEMBER),
    });
  });

  // THE ⋯ FOLLOWS WRITE ACCESS ON THE ROW'S OWN PROFILE (#4009 item 1 / #2106), which
  // is the rule #3958 states and phase 1 approximated with "is it the acting profile".
  // Two rows, one render, differing only in whose they are: the affordance appears on
  // the member this login may write and not on the one it may not. Asserted as a
  // COMPARISON between two real rows rather than against a constant, because a page
  // that had simply stopped drawing the menu would satisfy an absence assertion alone.
  //
  // This is the render half only. The gate is `gateItemProfile` inside each action —
  // see lib/__action_tests__/history-cross-profile-correction.actions.test.ts, which
  // posts what a forged submit would post and proves the write is refused.
  it("draws the ⋯ on a writable member's row and not on a read-only one", () => {
    const WRITABLE = ACTING + 1;
    const READ_ONLY = ACTING + 2;
    cleanup();
    render(
      <HistoryRows
        rows={[
          row({
            id: "food:98",
            kind: "food",
            profileId: WRITABLE,
            title: "Berries",
            edit: {
              kind: "food",
              eventId: 98,
              groupKey: "berries",
              mealSlot: "Morning",
              clock: null,
              clockKind: "logged",
            },
          }),
          row({
            id: "food:99",
            kind: "food",
            profileId: READ_ONLY,
            title: "Berries",
            edit: {
              kind: "food",
              eventId: 99,
              groupKey: "berries",
              mealSlot: "Morning",
              clock: null,
              clockKind: "logged",
            },
          }),
        ]}
        writableProfileIds={[ACTING, WRITABLE]}
        doseItems={[]}
        maxDates={{ [ACTING]: ACTING_TODAY }}
        defaultTime="09:00"
        subjectNames={{ [WRITABLE]: "Mia", [READ_ONLY]: "Sam" }}
      />
    );
    // One menu across two rows, and it is on Mia's.
    expect(screen.getAllByTestId("overflow-menu-trigger")).toHaveLength(1);
    const rows = screen.getAllByTestId("history-row");
    expect(
      rows[0].querySelector('[data-testid="overflow-menu-trigger"]')
    ).not.toBeNull();
    expect(
      rows[1].querySelector('[data-testid="overflow-menu-trigger"]')
    ).toBeNull();
    // And both still say whose they are (#534) — read-only is not anonymous.
    expect(
      screen.getAllByTestId("history-row-subject").map((n) => n.textContent)
    ).toEqual(["Mia", "Sam"]);
  });
});
