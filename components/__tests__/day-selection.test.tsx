import fs from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DayPickBox,
  DaySelectToggle,
  DaySelectionBar,
  DaySelectionProvider,
  type DaySelectionConfig,
} from "@/components/DaySelection";

// ONE SELECTION MODE, TWO PAGES (#5618 ruling 4, over #4118's ruling).
//
// The ledger's Select, pick boxes and three verbs were the record's too, and the thing
// this file exists to prevent is the record growing a SECOND implementation of them —
// the outcome the ruling names as its own failure. So the claims here are the two a
// deletion alone cannot make:
//
//   1. The same three pieces, mounted with each page's own config, behave the same and
//      hand the SAME batch to the SAME action. The record does not get its own write
//      path; "over the same per-row cores" is observable as the wire it posts.
//   2. Where the two mounts legitimately differ — Move to day…'s day — the ledger keeps
//      its page's seven-day offer and the record takes any real past day, which is what
//      the ruling says and what a shared list would have quietly broken.
//
// The FormData is read rather than "was the mock called": a record-only reimplementation
// would still call something, and only the posted rows say whether the ledger's cores
// were the ones that got them.

const posted: { action: string; fd: FormData }[] = [];
vi.mock("@/app/(app)/nutrition/intake-actions", () => {
  const capture = (action: string) => async (fd: FormData) => {
    posted.push({ action, fd });
    return { ok: true as const, applied: 3, refused: [] };
  };
  return {
    setLedgerSelectionTime: capture("setLedgerSelectionTime"),
    moveLedgerSelectionToDay: capture("moveLedgerSelectionToDay"),
    deleteLedgerSelection: capture("deleteLedgerSelection"),
  };
});
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));

const DAY = "2026-01-12";

// The two mounts' configs, each written the way its page writes it.
const LEDGER: DaySelectionConfig = {
  date: DAY,
  testIdPrefix: "ledger",
  selectable: true,
  moveTarget: {
    kind: "days",
    days: [
      { date: "2026-01-11", label: "Yesterday" },
      { date: "2026-01-10", label: "Sat" },
    ],
  },
};
const RECORD: DaySelectionConfig = {
  date: DAY,
  profileId: 7,
  testIdPrefix: "history",
  selectable: true,
  moveTarget: { kind: "date", max: "2026-02-01" },
};

/** The rows a day holds, as either page hangs boxes off them. */
const ROWS = [
  { kind: "servings" as const, id: 11, label: "Select the berries serving" },
  { kind: "servings" as const, id: 12, label: "Select the greens serving" },
  { kind: "doses" as const, id: 21, label: "Select the magnesium dose" },
];

function mount(config: DaySelectionConfig) {
  return render(
    <DaySelectionProvider config={config}>
      <DaySelectToggle />
      <DaySelectionBar />
      <ul>
        {ROWS.map((row) => (
          <li key={`${row.kind}-${row.id}`}>
            <DayPickBox kind={row.kind} id={row.id} label={row.label} />
          </li>
        ))}
      </ul>
    </DaySelectionProvider>
  );
}

/** Check all three rows' boxes, the mode already being on. */
function checkAllThree(prefix: string) {
  fireEvent.click(screen.getByTestId(`${prefix}-pick-serving-11`));
  fireEvent.click(screen.getByTestId(`${prefix}-pick-serving-12`));
  fireEvent.click(screen.getByTestId(`${prefix}-pick-dose-21`));
}

/** Enter the mode and check all three rows, the way a person does it. */
function selectAllThree(prefix: string) {
  fireEvent.click(screen.getByTestId(`${prefix}-select-toggle`));
  checkAllThree(prefix);
}

beforeEach(() => {
  posted.length = 0;
});
afterEach(cleanup);

describe.each([
  ["the ledger's mount", LEDGER],
  ["the record's mount", RECORD],
])("%s", (_name, config) => {
  const prefix = config.testIdPrefix;

  it("enters the mode from Select, and the boxes and the bar arrive with it", () => {
    mount(config);
    // The mode is OFF until somebody asks for it: no bar, and the rows carry no boxes.
    expect(screen.queryByTestId(`${prefix}-selection-bar`)).toBeNull();
    expect(screen.queryByTestId(`${prefix}-pick-serving-11`)).toBeNull();

    fireEvent.click(screen.getByTestId(`${prefix}-select-toggle`));
    expect(screen.getByTestId(`${prefix}-selection-bar`)).toBeTruthy();
    expect(screen.getByTestId(`${prefix}-selection-count`).textContent).toBe(
      "0 selected"
    );
    // Named boxes, one per selectable row — the accessible name is the row's own.
    expect(
      screen.getByTestId(`${prefix}-pick-serving-11`).getAttribute("aria-label")
    ).toBe("Select the berries serving");

    checkAllThree(prefix);
    expect(screen.getByTestId(`${prefix}-selection-count`).textContent).toBe(
      "3 selected"
    );
    for (const row of ROWS)
      expect(
        (
          screen.getByTestId(
            `${prefix}-pick-${row.kind === "servings" ? "serving" : "dose"}-${row.id}`
          ) as HTMLInputElement
        ).checked
      ).toBe(true);
  });

  it("Cancel leaves the mode and forgets what was picked", () => {
    mount(config);
    selectAllThree(prefix);
    fireEvent.click(screen.getByTestId(`${prefix}-select-toggle`));
    expect(screen.queryByTestId(`${prefix}-selection-bar`)).toBeNull();

    fireEvent.click(screen.getByTestId(`${prefix}-select-toggle`));
    expect(screen.getByTestId(`${prefix}-selection-count`).textContent).toBe(
      "0 selected"
    );
  });

  it("Set time 19:05 posts all three rows through the ledger's own action", () => {
    mount(config);
    selectAllThree(prefix);
    fireEvent.click(screen.getByTestId(`${prefix}-selection-set-time`));
    fireEvent.change(screen.getByTestId(`${prefix}-selection-when-time`), {
      target: { value: "19:05" },
    });
    fireEvent.click(screen.getByTestId(`${prefix}-selection-time-apply`));

    expect(posted).toHaveLength(1);
    expect(posted[0]!.action).toBe("setLedgerSelectionTime");
    const fd = posted[0]!.fd;
    expect(fd.get("date")).toBe(DAY);
    expect(fd.get("time")).toBe("19:05");
    // BOTH ID SPACES, exactly as the ledger's batch names them. A record-side
    // reimplementation is precisely what would post something else here.
    expect(fd.get("serving_ids")).toBe("11,12");
    expect(fd.get("dose_log_ids")).toBe("21");
  });

  it("a landed batch leaves the mode, so the boxes do not outlive their rows", async () => {
    mount(config);
    selectAllThree(prefix);
    fireEvent.click(screen.getByTestId(`${prefix}-selection-set-time`));
    fireEvent.change(screen.getByTestId(`${prefix}-selection-when-time`), {
      target: { value: "19:05" },
    });
    fireEvent.click(screen.getByTestId(`${prefix}-selection-time-apply`));
    await vi.waitFor(() =>
      expect(screen.queryByTestId(`${prefix}-selection-bar`)).toBeNull()
    );
    expect(screen.queryByTestId(`${prefix}-pick-serving-11`)).toBeNull();
  });
});

describe("Move to day… is the one thing the two mounts differ on (#5618 ruling 4)", () => {
  it("the ledger offers its page's own days and nothing wider", () => {
    mount(LEDGER);
    selectAllThree("ledger");
    fireEvent.click(screen.getByTestId("ledger-selection-move-day"));
    const select = screen.getByTestId(
      "ledger-selection-day-select"
    ) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "2026-01-11",
      "2026-01-10",
    ]);
    expect(screen.queryByTestId("ledger-selection-day-field")).toBeNull();

    fireEvent.change(select, { target: { value: "2026-01-10" } });
    fireEvent.click(screen.getByTestId("ledger-selection-day-apply"));
    expect(posted[0]!.action).toBe("moveLedgerSelectionToDay");
    expect(posted[0]!.fd.get("to_date")).toBe("2026-01-10");
  });

  it("the record takes a day the ledger's list could never have held", () => {
    mount(RECORD);
    selectAllThree("history");
    fireEvent.click(screen.getByTestId("history-selection-move-day"));
    expect(screen.queryByTestId("history-selection-day-select")).toBeNull();

    // WELL OUTSIDE ANY SEVEN-DAY OFFER — sixty days back from the day being read,
    // which is the case the record exists for and the list cannot express.
    fireEvent.change(screen.getByTestId("history-selection-day-field"), {
      target: { value: "2025-11-13" },
    });
    fireEvent.click(screen.getByTestId("history-selection-day-apply"));
    expect(posted[0]!.action).toBe("moveLedgerSelectionToDay");
    expect(posted[0]!.fd.get("to_date")).toBe("2025-11-13");
    // And the batch names its subject, because one batch gates one profile (#4009).
    expect(posted[0]!.fd.get("profile_id")).toBe("7");
  });
});

describe("the convergence itself", () => {
  // THE RULING'S OWN FAILURE CONDITION: "if your diff ends with two selection
  // implementations still alive, it has failed its own purpose." A behavioural test
  // cannot see a second implementation on a page it does not mount, so this reads the
  // two pages' sources for one — the bar, the boxes and the mode's state all belong to
  // components/DaySelection.tsx and neither page may re-declare them.
  const read = (file: string) =>
    fs.readFileSync(path.join(process.cwd(), file), "utf8");

  it.each([
    ["app/(app)/nutrition/DayLedger.tsx"],
    ["app/(app)/history/HistoryRows.tsx"],
    ["app/(app)/history/page.tsx"],
  ])("%s mounts the shared mode and declares none of its own", (file) => {
    const source = read(file);
    expect(source).toContain("@/components/DaySelection");
    // The bar's markup, the boxes' markup and the mode's own state, each named by the
    // one thing a second implementation would have to spell for itself.
    expect(source).not.toContain("selection-bar");
    expect(source).not.toContain("-pick-serving-");
    expect(source).not.toMatch(/useState[^\n]*selecting|setSelecting/);
  });
});
