import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HistoryRows from "@/app/(app)/history/HistoryRows";
import {
  detailSegment,
  historyClock,
  type HistoryRow,
} from "@/lib/history-format";
import {
  groupHistoryBundles,
  type HistoryBundleFact,
} from "@/lib/history-bundle";
import type { DisplayFormatPrefs } from "@/lib/format-date";

// WHAT A BUNDLE ROW ACTUALLY RENDERS, AND WHAT ITS ⋯ POSTS (#5618 ruling 5).
//
// WHY THIS TIER. The collapse rule is pure and driven at the unit tier
// (lib/__tests__/history-bundle.test.ts); what each batch action DOES with a payload is
// driven at the action and DB tiers. The half nobody else can see is the one in
// between — that the record draws ONE row for an act, names it, hangs its members off
// it, and that its three menu verbs post the ledger's three existing batch actions with
// the act's own two id spaces. Every assertion below is on the rendered row or on the
// payload a Server Action was HANDED, never on whether a mock was called.
//
// NO NEW WRITE PATH is asserted structurally: the three actions mocked below are the
// three `lib/day-ledger-edit.ts` already had. A bundle row reaching for a fourth would
// post to something unmocked and fail here rather than quietly ship.

/** Every payload each batch action was handed, by action name. */
const posted: Record<string, FormData[]> = {};

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  setLedgerSelectionTime: async (fd: FormData) => {
    (posted.setLedgerSelectionTime ??= []).push(fd);
    return { ok: true, applied: 8, refused: [] };
  },
  moveLedgerSelectionToDay: async (fd: FormData) => {
    (posted.moveLedgerSelectionToDay ??= []).push(fd);
    return { ok: true, applied: 8, refused: [] };
  },
  deleteLedgerSelection: async (fd: FormData) => {
    (posted.deleteLedgerSelection ??= []).push(fd);
    return { ok: true, applied: 8, refused: [] };
  },
  deleteAdministration: async () => ({ undoId: 1 }),
  logHistoricalDose: async () => ({ ok: true }),
  updateHistoricalDose: async () => ({ ok: true }),
}));

// The other domains this component can mount. No case below opens a MEMBER's own form,
// so a branch reaching one is a defect rather than coverage. Each factory builds its own
// thrower — `vi.mock` is hoisted above every top-level binding, so a shared helper
// declared here would be read before it exists.
function unowned(name: string) {
  return () => {
    throw new Error(`history-bundle-row does not cover ${name}`);
  };
}
vi.mock("@/app/(app)/nutrition/actions", () => ({
  updateFoodLogEvent: unowned("food correction"),
  deleteFoodLogEvent: unowned("food delete"),
}));
vi.mock("@/app/(app)/wellness/actions", () => ({
  editPracticeSession: unowned("practice correction"),
  removePracticeSession: unowned("practice delete"),
}));
vi.mock("@/app/(app)/medical/substance-use/actions", () => ({
  correctSubstanceUseAction: unowned("substance correction"),
  deleteSubstanceUseAction: unowned("substance delete"),
}));
vi.mock("@/app/(app)/trends/reading-actions", () => ({
  updateMetricReading: unowned("reading correction"),
  deleteMetricReading: unowned("reading delete"),
}));
vi.mock("@/app/(app)/mood-actions", () => ({ logMood: unowned("mood") }));
vi.mock("@/app/(app)/symptom-actions", () => ({
  editSymptom: unowned("symptom correction"),
  removeSymptom: unowned("symptom delete"),
}));
vi.mock("@/app/(app)/medical/cycles/actions", () => ({
  deleteCycleAction: unowned("cycle delete"),
  saveCycleAction: unowned("cycle save"),
}));

// The row's neighbours: none of them decides what a bundle row means.
let confirmed = true;
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => confirmed,
  useConfirmOpen: () => false,
  useOptionalConfirm: () => null,
}));
vi.mock("@/components/useUndoableDelete", () => ({
  useUndoableDelete:
    () => async (action: (fd: FormData) => Promise<unknown>, fd: FormData) => {
      await action(fd);
    },
}));
vi.mock("@/components/FormatPrefsProvider", () => ({
  useFormatPrefs: () => ({ timeFormat: "24h", dateFormat: "iso" }),
}));
vi.mock("@/components/TimezoneProvider", () => ({ useTimezone: () => "UTC" }));
vi.mock("@/components/OfflineQueueProvider", () => ({
  useOfflineQueue: () => ({
    enqueue: async () => "kept",
    enqueueBatch: async () => "kept",
  }),
  useQueuedDayContextCapture: () => () => null,
}));

beforeEach(() => {
  for (const key of Object.keys(posted)) delete posted[key];
  confirmed = true;
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
  })) as never;
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
const DAY = "2026-09-08";
const TODAY = "2026-09-10";
const H24: DisplayFormatPrefs = { timeFormat: "24h", dateFormat: "iso" };

function row(over: Partial<HistoryRow> & Pick<HistoryRow, "id" | "kind">) {
  return {
    profileId: ACTING,
    tz: "UTC",
    date: DAY,
    sortTime: "07:41",
    clock: historyClock("07:41", "logged", H24, {
      filedDay: TODAY,
      rowDay: DAY,
    }),
    clockKind: "logged" as const,
    title: "A row",
    href: null,
    detail: detailSegment([]),
    media: 0,
    edit: null,
    ...over,
  } as HistoryRow;
}

/** The usual tap on a past day: two servings and two dose confirms, one act. */
const USUAL_ROWS: HistoryRow[] = [
  row({ id: "food:11", kind: "food", title: "Fermented foods" }),
  row({ id: "food:12", kind: "food", title: "Berries" }),
  row({ id: "dose:21", kind: "dose", title: "Creatine" }),
  row({ id: "dose:22", kind: "dose", title: "B complex" }),
];

const USUAL_FACTS = new Map<string, HistoryBundleFact>([
  [
    "food:11",
    { bundleId: "act1", window: "Morning", stack: null, bucket: null },
  ],
  [
    "food:12",
    { bundleId: "act1", window: "Morning", stack: null, bucket: null },
  ],
  [
    "dose:21",
    {
      bundleId: "act1",
      window: null,
      stack: "Morning Smoothie",
      bucket: "Morning",
    },
  ],
  [
    "dose:22",
    {
      bundleId: "act1",
      window: null,
      stack: "Morning Smoothie",
      bucket: "Morning",
    },
  ],
]);

function draw(
  rows: HistoryRow[],
  facts: Map<string, HistoryBundleFact>,
  writableProfileIds: number[] = [ACTING]
): void {
  cleanup();
  render(
    <HistoryRows
      rows={groupHistoryBundles(rows, facts)}
      writableProfileIds={writableProfileIds}
      doseItems={[]}
      maxDates={{ [ACTING]: TODAY }}
      defaultTime="09:00"
      subjectNames={{}}
    />
  );
}

function only(action: string): Record<string, string> {
  const all = posted[action] ?? [];
  expect(all, `${action} was handed ${all.length} payloads`).toHaveLength(1);
  return Object.fromEntries(
    [...all[0]!.entries()].map(([k, v]) => [k, String(v)])
  );
}

async function openMenu(item: string): Promise<void> {
  fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
  await act(async () => fireEvent.click(screen.getByTestId(item)));
}

describe("a bundle is one row, named now", () => {
  it("draws one row for the act and none of its members until it is opened", () => {
    draw(USUAL_ROWS, USUAL_FACTS);
    expect(screen.getAllByTestId("history-bundle")).toHaveLength(1);
    expect(screen.queryAllByTestId("history-row")).toHaveLength(0);
    expect(screen.getByTestId("history-bundle-title").textContent).toBe(
      "Your usual Morning"
    );
    // #5074 B's "Your usual Morning · 6 doses" as the row's own two cells.
    expect(screen.getByTestId("history-bundle-detail").textContent).toBe(
      "2 servings · 2 doses"
    );
    // Ruling 6's clock, on the act: a past day filed today says which day, no clock.
    expect(screen.getByTestId("history-bundle-clock").textContent).toBe(
      "logged 2026-09-10"
    );
    // ITS OWN CELLS, not the plain row's. The act reuses the row grammar, not the row's
    // test ids: several specs count `history-row-*` and a collapsed act must not move a
    // number they measure.
    expect(screen.queryByTestId("history-row-title")).toBeNull();
    expect(screen.queryByTestId("history-row-clock")).toBeNull();
  });

  it("hangs its members beneath it, each still its own row", () => {
    draw(USUAL_ROWS, USUAL_FACTS);
    const toggle = screen.getByTestId("history-bundle-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const members = screen.getAllByTestId("history-row");
    expect(members).toHaveLength(4);
    expect(members.map((li) => li.getAttribute("data-history-row-id"))).toEqual(
      ["food:11", "food:12", "dose:21", "dose:22"]
    );
    // The act's row is still the FIRST line: the members are its siblings beneath it,
    // never children of it (#4045 §4, the rule the rollup's rows follow too).
    const list = screen.getByTestId("history-rows");
    expect(
      [...list.children].map((li) => li.getAttribute("data-testid"))
    ).toEqual([
      "history-bundle",
      "history-row",
      "history-row",
      "history-row",
      "history-row",
    ]);
  });

  it("names a dose-only act after the stack its members declare", () => {
    draw(
      [
        row({ id: "dose:31", kind: "dose", title: "Creatine" }),
        row({ id: "dose:32", kind: "dose", title: "Collagen" }),
      ],
      new Map([
        [
          "dose:31",
          {
            bundleId: "act2",
            window: null,
            stack: "Sleep stack",
            bucket: null,
          },
        ],
        [
          "dose:32",
          {
            bundleId: "act2",
            window: null,
            stack: "Sleep stack",
            bucket: null,
          },
        ],
      ])
    );
    expect(screen.getByTestId("history-bundle-title").textContent).toBe(
      "Sleep stack"
    );
    expect(screen.getByTestId("history-bundle-detail").textContent).toBe(
      "2 doses"
    );
  });
});

// THE BOUNDARY MOST LIKELY TO BREAK SILENTLY, asserted on the RENDER as well as on the
// rule: rows written before 2026-09-04 carry no act id, and a grouping keyed on that
// absence would fold unrelated rows into one row stating one time for all of them.
describe("rows written before 2026-09-04 stay flat", () => {
  it("renders one row per row when nothing recorded an act", () => {
    const old = [
      row({ id: "dose:91", kind: "dose", title: "Creatine" }),
      row({ id: "dose:92", kind: "dose", title: "Collagen" }),
      row({ id: "food:93", kind: "food", title: "Fermented foods" }),
    ];
    draw(old, new Map());
    expect(screen.queryAllByTestId("history-bundle")).toHaveLength(0);
    expect(screen.getAllByTestId("history-row")).toHaveLength(3);
    expect(
      screen.getAllByTestId("history-row-title").map((n) => n.textContent)
    ).toEqual(["Creatine", "Collagen", "Fermented foods"]);
  });

  it("leaves the old rows alone on a day that also holds an act", () => {
    draw(
      [
        ...USUAL_ROWS,
        row({ id: "dose:99", kind: "dose", title: "Old vitamin" }),
      ],
      USUAL_FACTS
    );
    expect(screen.getAllByTestId("history-bundle")).toHaveLength(1);
    const flat = screen.getAllByTestId("history-row");
    expect(flat).toHaveLength(1);
    expect(flat[0]!.getAttribute("data-history-row-id")).toBe("dose:99");
  });
});

describe("what the act's ⋯ offers, and what it posts", () => {
  it("offers Edit, Move to day… and Delete all, and nothing else", () => {
    draw(USUAL_ROWS, USUAL_FACTS);
    fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
    expect(
      screen.getAllByRole("menuitem").map((node) => node.textContent?.trim())
    ).toEqual(["Edit", "Move to day…", "Delete all"]);
  });

  it("draws no ⋯ at all on an act this login may not write", () => {
    draw(USUAL_ROWS, USUAL_FACTS, []);
    expect(screen.queryByTestId("overflow-menu-trigger")).toBeNull();
  });

  // "Edit on a bundle row opens the When row only, one time for the act" — the sheet
  // holds the When control and its Save, and no field naming any member.
  it("opens the When row only, and stamps one time on every member", async () => {
    draw(USUAL_ROWS, USUAL_FACTS);
    await openMenu("history-bundle-edit");
    const sheet = screen.getByTestId("history-bundle-edit-sheet-bundle:act1");
    // THE WHEN ROW AND NOTHING ELSE. The sheet holds the one control and its Save; a
    // field naming a member — a food group, a dose amount, a note — would be this row
    // claiming to edit what its members ARE, which is each member's own ⋯ one row down.
    expect(
      sheet.querySelector("[data-testid='history-bundle-when']")
    ).not.toBeNull();
    expect(
      [...sheet.querySelectorAll("input, select, textarea")].map((node) =>
        node.getAttribute("data-testid")
      )
    ).toEqual(["history-bundle-when-time"]);
    // The day is FIXED to the one being read (min === max), so the control renders it as
    // TEXT rather than a second picker — re-dating stays Move to day…'s question, and
    // the pair rule holds trivially.
    expect(
      sheet.querySelector("[data-testid='history-bundle-when-date']")!.tagName
    ).toBe("SPAN");
    fireEvent.change(screen.getByTestId("history-bundle-when-time"), {
      target: { value: "07:30" },
    });
    await act(async () =>
      fireEvent.click(screen.getByTestId("history-bundle-time-apply"))
    );
    expect(only("setLedgerSelectionTime")).toEqual({
      date: DAY,
      profile_id: String(ACTING),
      serving_ids: "11,12",
      dose_log_ids: "21,22",
      time: "07:30",
    });
    expect(posted.moveLedgerSelectionToDay).toBeUndefined();
    expect(posted.deleteLedgerSelection).toBeUndefined();
  });

  it("moves the whole act to another day through a date field", async () => {
    draw(USUAL_ROWS, USUAL_FACTS);
    await openMenu("history-bundle-move-day");
    const field = screen.getByTestId(
      "history-bundle-day-field"
    ) as HTMLInputElement;
    // A DATE FIELD AND NOT A SEVEN-DAY LIST, exactly as ruling 4 widened the record's
    // batch: there is no floor, so a day well outside any offer the ledger could hold
    // is reachable — which is the case the record exists for.
    expect(screen.queryByTestId("history-bundle-day-select")).toBeNull();
    fireEvent.change(field, { target: { value: "2025-11-13" } });
    await act(async () =>
      fireEvent.click(screen.getByTestId("history-bundle-day-apply"))
    );
    expect(only("moveLedgerSelectionToDay")).toEqual({
      date: DAY,
      profile_id: String(ACTING),
      serving_ids: "11,12",
      dose_log_ids: "21,22",
      to_date: "2025-11-13",
    });
  });

  it("deletes every member of the act, once the question is answered", async () => {
    draw(USUAL_ROWS, USUAL_FACTS);
    await openMenu("history-bundle-delete");
    expect(only("deleteLedgerSelection")).toEqual({
      date: DAY,
      profile_id: String(ACTING),
      serving_ids: "11,12",
      dose_log_ids: "21,22",
    });
  });

  it("writes nothing when the delete question is declined", async () => {
    confirmed = false;
    draw(USUAL_ROWS, USUAL_FACTS);
    await openMenu("history-bundle-delete");
    expect(posted.deleteLedgerSelection).toBeUndefined();
  });
});
