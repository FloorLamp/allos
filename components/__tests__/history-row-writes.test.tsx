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
// NO NEW WRITE PATHS is asserted structurally: the mocks below are the five actions
// that already existed. A sixth write reaching this component would post to something
// unmocked and fail here rather than quietly ship.

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
  deleteFoodLogEvent: async () => ({ ok: true, undoId: 1 }),
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  editPracticeSession: async (fd: FormData) => {
    record("editPracticeSession")(fd);
    return { kind: "updated" };
  },
  removePracticeSession: async () => ({ undoId: 1 }),
}));
vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  updateSubstanceDailyTotalAction: async (fd: FormData) => {
    record("updateSubstanceDailyTotalAction")(fd);
    return { kind: "updated" };
  },
  deleteSubstanceDailyTotalAction: async () => ({
    kind: "deleted",
    undoId: 1,
  }),
}));
vi.mock("@/app/(app)/trends/reading-actions", () => ({
  updateMetricReading: async (fd: FormData) => {
    record("updateMetricReading")(fd);
    return { ok: true };
  },
  deleteMetricReading: async () => ({ undoId: 1 }),
}));

// The row's neighbours: none of them decides what a correction means.
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
  useConfirmOpen: () => false,
  useOptionalConfirm: () => null,
}));
vi.mock("@/components/useUndoableDelete", () => ({
  useUndoableDelete: () => async () => {},
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

function row(over: Partial<HistoryRow> & Pick<HistoryRow, "id" | "kind">) {
  return {
    profileId: ACTING,
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

async function openEdit(rows: HistoryRow[]): Promise<void> {
  cleanup();
  render(
    <HistoryRows
      rows={rows}
      actingProfileId={ACTING}
      canWrite
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
      maxDate="2026-08-28"
      defaultTime="09:00"
      subjectNames={{}}
    />
  );
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

  // THE AFFORDANCE IS NOT THE GATE, but it must not render where it cannot act: every
  // action above resolves its subject from the session, so a ⋯ on another member's
  // row in `?view=everyone` would write to the wrong subject (#2106).
  it("renders no ⋯ on a row belonging to another member", () => {
    cleanup();
    render(
      <HistoryRows
        rows={[
          row({
            id: "food:99",
            kind: "food",
            profileId: ACTING + 1,
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
        actingProfileId={ACTING}
        canWrite
        doseItems={[]}
        maxDate="2026-08-28"
        defaultTime="09:00"
        subjectNames={{ [ACTING + 1]: "Mia" }}
      />
    );
    expect(screen.queryByTestId("overflow-menu-trigger")).toBeNull();
    expect(screen.getByTestId("history-row-subject").textContent).toBe("Mia");
  });
});
