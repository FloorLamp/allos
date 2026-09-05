import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MedicationCard from "@/app/(app)/medications/MedicationCard";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import { emptyIntakeItemFormState } from "@/lib/intake-form-fields";

// ONE STATE SHAPE FOR THE INTAKE FORM (#4664).
//
// The form used to hold its 29 posted facts in 29 `useState` hooks and re-enumerate
// the field list five more times — the seeding expressions, the posted-state memo,
// that memo's 37-entry dependency array, the draft restore and the reset. Each
// omission had its own silent bug, and none of them had a test, because every one of
// them is invisible until a field is added and forgotten.
//
// WHAT THIS FILE PINS, in the two halves that stay true when a 41st field arrives:
//
//  1. A stored row still round-trips. An edit mount posts every fact the row carries,
//     with NO editor opened — the #2014 hidden-is-not-unmounted rule, now also the
//     proof that the seeding factory feeds the mapping. The expectation is a
//     hand-transcribed map compared WHOLE, so a dropped field and a stray extra one
//     both fail, and neither can be satisfied by a form that rendered nothing.
//  2. No posted fact has a hook of its own any more. Scanned, with the scan itself
//     driven against a planted violation first — a scan that finds nothing is the
//     same result whether the property holds or the regex is wrong.

const actions = vi.hoisted(() => ({
  update: vi.fn(async (_data: FormData) => ({ ok: true as const })),
}));

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  updateIntakeItem: actions.update,
  addIntakeItem: vi.fn(async () => ({ ok: true })),
  lookupRxcui: vi.fn(async () => []),
  lookupRxcuiIngredients: vi.fn(async () => []),
}));
vi.mock("@/app/(app)/supplies/actions", () => ({
  listSharedSupplyOptions: vi.fn(async () => []),
  createPoolAction: vi.fn(async () => ({ ok: true })),
  linkItemAction: vi.fn(async () => ({ ok: true })),
  unlinkItemAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/medications",
  useSearchParams: () => new URLSearchParams(),
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

/** A stored medication stating every fact this form owns an editor for. */
const ROW = {
  id: 42,
  name: "Ibuprofen",
  notes: "half a tablet on bad days",
  active: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  condition: "situational",
  obligation: "may",
  brand: "Advil",
  product: "Liqui-Gels",
  situation: "a migraine",
  situation_id: null,
  pause_situation: "a stomach bug",
  pause_situation_id: null,
  stack: null,
  critical: 1,
  escalate_after_min: 45,
  escalate_chat_id: "chat-9",
  quantity_on_hand: 30,
  qty_per_dose: 2,
  supply_id: 11,
  supply_name: "The household ibuprofen",
  last_fill_size: null,
  kind: "medication",
  prescriber: "Dr. Rivera",
  pharmacy: "Walgreens #1234",
  rx_number: "RX7654321",
  rx: 1,
  min_interval_hours: 6,
  max_daily_count: 4,
  max_daily_amount_mg: 1200,
  redose_notice: 1,
  rxcui: "5640",
  rxcui_ingredients: '["5640"]',
  document_id: null,
  source: null,
  source_name: null,
  provider_id: 8,
  provider_name: "Sample Care East",
  source_record_id: null,
  indication_condition_id: 3,
  indication_condition_name: "Migraine",
  cadence_kind: "weekly",
  cadence_weekdays: "4,1",
  cadence_interval_days: 3,
  cadence_anchor_date: "2026-02-02",
  purposes_json: null,
  ingredients_json: null,
};

const EDIT_MOUNT = {
  medication: ROW,
  doses: [
    {
      id: 5,
      amount: "200 mg",
      time_of_day: "Morning",
      food_timing: "with_food",
      weekdays: "6,2",
      start_date: "2026-03-01",
      end_date: "2026-04-01",
    },
  ],
  ingredients: [
    {
      id: 1,
      item_id: 42,
      name: "Ibuprofen",
      amount_text: "200 mg",
      amount: 200,
      unit: "mg",
      sort: 0,
    },
  ],
  pairs: [
    { id: 3, a_id: 42, b_id: 7, relation: "separate", note: "2 hours apart" },
  ],
  courses: [
    {
      id: 77,
      item_id: 42,
      started_on: "2026-01-15",
      stopped_on: null,
      stop_reason: null,
      notes: null,
      prescriber: null,
      provider_id: null,
      dose_snapshot: null,
      created_at: "2026-01-15T00:00:00.000Z",
    },
  ],
  conditions: [{ id: 3, name: "Migraine" }],
  allIntakeItems: [
    { id: 42, name: "Ibuprofen" },
    { id: 7, name: "Levothyroxine" },
  ],
  stackItems: [],
  pgxVariants: [],
  sideEffects: [],
  strip: [],
  takenDoseIds: [],
  skippedDoseIds: [],
  doseHistory: [],
  todayStr: "2026-09-04",
  initialAction: "edit",
} as unknown as Parameters<typeof MedicationCard>[0];

/** Every fact the row states, as the action's own field names. */
const EXPECTED: Record<string, string> = {
  id: "42",
  kind: "medication",
  name: "Ibuprofen",
  brand: "Advil",
  product: "Liqui-Gels",
  condition: "situational",
  situation: "a migraine",
  pause_situation: "a stomach bug",
  obligation: "may",
  notes: "half a tablet on bad days",
  critical: "1",
  escalate_after_min: "45",
  escalate_chat_id: "chat-9",
  cadence_kind: "weekly",
  cadence_weekdays: "1,4",
  cadence_interval_days: "3",
  cadence_anchor_date: "2026-02-02",
  rx: "1",
  prescriber: "Dr. Rivera",
  pharmacy: "Walgreens #1234",
  rx_number: "RX7654321",
  provider: "Sample Care East",
  provider_id: "8",
  provider_loaded: "Sample Care East",
  indication_condition_id: "3",
  started_on: "2026-01-15",
  course_id: "77",
  end_date: "",
  min_interval_hours: "6",
  max_daily_count: "4",
  max_daily_amount_mg: "1200",
  redose_notice: "1",
  rxcui: "5640",
  rxcui_ingredients: '["5640"]',
  quantity_on_hand: "30",
  qty_per_dose: "2",
  quantity_on_hand_loaded: "30",
  supply_id: "11",
};

/** The four child-row fields, compared as parsed JSON rather than as strings. */
const JSON_FIELDS = ["doses", "pairs", "ingredients", "purposes"] as const;

function mountEdit() {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <MedicationCard {...EDIT_MOUNT} />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe("an edit mount posts the whole row back, with no editor opened (#4664)", () => {
  it("shows the stored facts on the chip row it opens on", async () => {
    // POSITIVE CONTROL for the save below: the form really did seed itself from the
    // row, so "the FormData carried the row" is not a form that rendered nothing.
    mountEdit();
    expect(
      (screen.getByRole("combobox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("Ibuprofen");
    expect(screen.getByTestId("intake-fact-dose").textContent).toContain(
      "200 mg"
    );
  });

  it("posts every fact the row states, and nothing besides", async () => {
    actions.update.mockClear();
    mountEdit();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(actions.update).toHaveBeenCalledOnce());

    const posted = Object.fromEntries(
      actions.update.mock.calls[0][0].entries()
    ) as Record<string, string>;
    const child = Object.fromEntries(
      JSON_FIELDS.map((k) => [k, JSON.parse(posted[k] ?? "null")])
    );
    for (const k of JSON_FIELDS) delete posted[k];

    // WHOLE, not a sample: an extra key fails this as loudly as a missing one.
    expect(posted).toEqual(EXPECTED);

    // The dose row keeps its own identity and window, and takes its food relationship
    // from the rule sentence that owns it for every row.
    expect(child.doses).toEqual([
      {
        id: 5,
        amount: "200 mg",
        time_of_day: "Morning",
        food_timing: "with_food",
        weekdays: [2, 6],
        start_date: "2026-03-01",
        end_date: "2026-04-01",
      },
    ]);
    expect(child.ingredients).toEqual([
      { name: "Ibuprofen", amount: "200 mg" },
    ]);
    expect(child.pairs).toMatchObject([{ otherId: 7, relation: "separate" }]);
    expect(child.purposes).toEqual([]);
  });
});

// ── The shape itself ─────────────────────────────────────────────────────────

const FORM_SOURCE = readFileSync("components/IntakeItemForm.tsx", "utf8");

/** The declared `useState` hooks in `source` whose value is a posted fact. */
function perFieldHooks(source: string): string[] {
  const fields = new Set(Object.keys(emptyIntakeItemFormState("medication")));
  return [
    ...source.matchAll(
      /const \[\s*([A-Za-z_$][\w$]*)\s*,\s*set[\w$]*\s*\]\s*=\s*use(?:Resettable)?State/g
    ),
  ]
    .map((m) => m[1])
    .filter((n) => fields.has(n));
}

/** Every declared `useState` / `useResettableState` hook, posted fact or not. */
function stateHooks(source: string): string[] {
  return [
    ...source.matchAll(
      /const \[\s*([A-Za-z_$][\w$]*)\s*,[^\]]*\]\s*=\s*use(?:Resettable)?State/g
    ),
  ].map((m) => m[1]);
}

describe("the form holds its posted facts in one shape (#4664)", () => {
  // THE SCAN'S OWN FLOOR. "No per-field hook found" is the same output whether the
  // property holds or the regex never matched, so the regex is run against planted
  // violations first — including the WRAPPED declaration a line-anchored pattern
  // misses, which is how a census in this tree has already shipped blind once.
  it("finds a per-field hook when there is one", () => {
    expect(perFieldHooks(`const [notes, setNotes] = useState("");`)).toEqual([
      "notes",
    ]);
    expect(
      perFieldHooks(
        `  const [maxDailyCount, setMaxDailyCount] =\n    useState<string>("");`
      )
    ).toEqual(["maxDailyCount"]);
    // And it does not mistake a hook that merely shares a word with a field.
    expect(
      perFieldHooks(`const [nameOptions, setNameOptions] = useState([]);`)
    ).toEqual([]);
  });

  it("keeps no hook of its own for a posted fact", () => {
    expect(perFieldHooks(FORM_SOURCE)).toEqual([]);
  });

  // AND A COUNT, because the scan above is by field NAME and the old form held `rx`
  // in a hook called `rxFlag` — a per-field hook under another spelling would walk
  // straight past it. Thirteen: the one posted state, and twelve hooks that are not
  // facts about the item (the open panel's add-mode flag, the offered bottles, the
  // brand narrowing, the start-date latch, the linked bottle's label, the prefill
  // ledger, the formulation slug, the selected weight band, the pediatric context,
  // the ingredient seed note, the rule sentences, and the error). This number moves
  // only when someone has decided a new hook is one of those.
  it("declares one hook for the facts and twelve that are not facts", () => {
    expect(stateHooks(FORM_SOURCE).length).toBe(13);
    expect(stateHooks(FORM_SOURCE)).toContain("state");
  });
});
