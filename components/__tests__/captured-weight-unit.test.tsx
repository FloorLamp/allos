import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette, { SEARCH_OPEN_EVENT } from "@/components/CommandPalette";
import MetricReadingsTable from "@/components/MetricReadingsTable";
import BodyMetricRowMenu from "@/app/(app)/trends/BodyMetricRowMenu";
import { bodyMetricMeasures } from "@/lib/body-metric-measures";
import type { WeightUnit } from "@/lib/settings";

// THE THREE SURFACES SEND THE UNIT THEY RENDERED IN (#3853, following #2863).
//
// Each of them puts a weight on screen in the login's unit and then posts a bare
// number, so the write re-read the pref — a pref a flip in another tab or on another
// device has already changed, converting the value 2.2046× out.
//
// WHY THIS TIER: what the ACTIONS do with a carried unit is driven over a DIFFERING
// stored pref in lib/__action_tests__/weight-unit-carry.actions.test.ts. Whether the
// unit is in the payload AT ALL only exists once something is mounted, and that is the
// half that was missing.

/** What `updateMetricReading` was HANDED — posted, not intended. */
const posted: FormData[] = [];

vi.mock("@/app/(app)/trends/reading-actions", () => ({
  updateMetricReading: async (fd: FormData) => {
    posted.push(fd);
    return { ok: true };
  },
  deleteMetricReading: async () => ({ undoId: null }),
}));
vi.mock("@/app/(app)/trends/body-actions", () => ({
  deleteBodyMetric: async () => ({ undoId: null }),
}));
/** The unit `paletteQuickLog` was HANDED alongside the typed line. */
const palettePosted: (string | undefined)[] = [];

vi.mock("@/app/(app)/palette-actions", () => ({
  paletteQuickLog: async (_input: string, capturedUnit?: string) => {
    palettePosted.push(capturedUnit);
    return { ok: true, message: "Logged." };
  },
}));
// The palette's own neighbours: none of them decides what a weight means.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/app/(app)/search-actions", () => ({
  runGlobalSearch: async () => [],
  askRecordsAction: async () => ({ ok: false, error: "off" }),
}));
vi.mock("@/app/(app)/quick-entry-actions", () => ({
  loadQuickEntry: async () => ({ form: "practice", practices: [] }),
}));
vi.mock("@/app/(app)/medications/actions", () => ({
  logMedicationAdministration: async () => ({ ok: true }),
  refillMedication: async () => ({ ok: true }),
}));
vi.mock("@/app/(app)/encounters/appointment-actions", () => ({
  completeAppointment: async () => ({ ok: true }),
}));
vi.mock("@/components/ActivityEditorProvider", () => ({
  useActivityEditor: () => ({
    openCreate: () => {},
    openLive: () => {},
    openRepeatLast: () => {},
    hasLastActivity: false,
    canStartWorkout: false,
    trainingRelevant: false,
    workoutOffer: null,
  }),
}));
vi.mock("@/components/QuickEntryProvider", () => ({
  useQuickEntry: () => ({ open: () => {} }),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
  useConfirmOpen: () => false,
  useOptionalConfirm: () => null,
}));
vi.mock("@/components/useUndoableDelete", () => ({
  useUndoableDelete: () => async () => {},
}));

beforeEach(() => {
  posted.length = 0;
  palettePosted.length = 0;
  Element.prototype.scrollIntoView ??= () => {};
  // jsdom has neither a resize observer nor a media-query engine; the ⋯ menu's
  // anchored panel wants the first and the modal's sheet asks the second about
  // reduced motion the moment it mounts.
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

/** 80 kg, as the row that page would print it. */
const STORED_KG = 80;

// The metric detail page's readings table: ⋯ → Edit → type → Save.
async function driveReadingsTable(unit: WeightUnit): Promise<void> {
  cleanup();
  render(
    <MetricReadingsTable
      kind="weight"
      unit={` ${unit}`}
      weightUnit={unit}
      rows={[
        {
          id: 1,
          date: "2026-07-01",
          target: "body_metrics:1:weight_kg",
          display: "80",
          editValue: STORED_KG,
          source: null,
          flag: null,
          edited: false,
          notes: null,
        },
      ]}
    />
  );
  fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Reading value"), {
    target: { value: "82" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
  );
}

// The Trends body census row: ⋯ → Edit weight → type → Save.
async function driveRowMenu(unit: WeightUnit): Promise<void> {
  cleanup();
  render(
    <BodyMetricRowMenu
      id={1}
      label="Jul 1"
      weightUnit={unit}
      measures={bodyMetricMeasures(
        { id: 1, weight_kg: STORED_KG, body_fat_pct: null, resting_hr: null },
        unit
      )}
    />
  );
  fireEvent.click(screen.getByTestId("overflow-menu-trigger"));
  fireEvent.click(screen.getByTestId("body-history-edit-weight_kg"));
  fireEvent.change(screen.getByTestId("body-metric-edit-value"), {
    target: { value: "82" },
  });
  await act(async () =>
    fireEvent.click(screen.getByTestId("body-metric-edit-save"))
  );
}

// The command palette: open, type an UNSUFFIXED number, commit the previewed row.
async function drivePalette(unit: WeightUnit): Promise<void> {
  cleanup();
  render(<CommandPalette profileName="Someone" weightUnit={unit} />);
  await act(async () => {
    window.dispatchEvent(new Event(SEARCH_OPEN_EVENT));
  });
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "weight 82" } });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

describe("a weight write carries the unit it was captured in", () => {
  it.each([
    {
      surface: "the metric detail page's readings table",
      drive: driveReadingsTable,
    },
    { surface: "the Trends body census row menu", drive: driveRowMenu },
  ])("$surface posts weight_unit for both units", async ({ drive }) => {
    // BOTH units, because a hard-coded field satisfies either one alone — and the
    // pre-filled value is the same 80 kg either way, so only the unit distinguishes them.
    await drive("kg");
    await drive("lb");
    expect(posted.map((fd) => fd.get("weight_unit"))).toEqual(["kg", "lb"]);
  });

  // An ENTRY path rather than a correction, and its window is seconds rather than a
  // page lifetime — but the same mechanism: the palette previews an unsuffixed number
  // in a unit ("Log weight · 82 kg") and the server re-parses the raw line, so the
  // unit read there has to be the one the preview was parsed against.
  it("the command palette commits the unit it previewed in", async () => {
    await drivePalette("kg");
    await drivePalette("lb");
    expect(palettePosted).toEqual(["kg", "lb"]);
  });
});
