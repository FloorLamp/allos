import { intakeFormContext } from "./intake-form-context-fixture";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ActiveProfileProvider } from "@/components/ActiveProfileProvider";
import type { FormDraft } from "@/lib/offline/drafts";
import type { SupplyOption } from "@/lib/supply-product";
import { PREFILL_FIELDS, type PrefillField } from "@/lib/intake-prefill";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import MedicationAddWorkspace from "@/app/(app)/medications/MedicationAddWorkspace";
import AddSupplementModal from "@/components/nutrition/AddSupplementModal";
import CreateAction from "@/components/CreateAction";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";

// ONE PREFILL DISCIPLINE FOR EVERY SEED PATH (#4665).
//
// The form has seven seeding entry points answering "may I overwrite this field?" with
// four different mechanisms — the `touched` set, the `suggestedFields` set,
// `applyProductSeed`'s previous-seed comparison, and bare empty-checks. Where the
// mechanisms disagree the divergence is a live bug, and these are the three the issue
// reports. Each test drives the REAL form through the real controls, because every one
// of the three is a correct rule with a consumer that does not consult it.
//
// EVERY CASE CARRIES ITS POSITIVE CONTROL. "The hand-typed number survived" also passes
// on a form where nothing happened at all, and "no from-label badge" passes on a form
// that rendered no chips — so each test first pins the same interaction reaching the
// same state by the arm that DOES honour the rule.

// The PRN resolver, wrapped rather than replaced: every consumer keeps the real
// dataset answer, and the calls are recorded so "how many times was this fact
// resolved, and from what code" is answerable.
const prnSpy = vi.hoisted(() => ({
  calls: [] as { name: string; rxcui: string | null }[],
}));
vi.mock("@/lib/prn-defaults", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prn-defaults")>();
  return {
    ...real,
    prnDefaultsFor: (item: {
      name: string;
      rxcui: string | null;
      rxcuiIngredients?: string[] | null;
    }) => {
      prnSpy.calls.push({ name: item.name, rxcui: item.rxcui ?? null });
      return real.prnDefaultsFor(item);
    },
  };
});

const actions = vi.hoisted(() => ({
  getDraft: vi.fn(async (): Promise<FormDraft | null> => null),
  putDraft: vi.fn(async (_draft: FormDraft) => {}),
  listSharedSupplyOptions: vi.fn(async (): Promise<SupplyOption[]> => []),
  addIntakeItem: vi.fn(async (_data: FormData) => ({ ok: true as const })),
  // RxNorm resolves each ingredient to its own concept id, which is what makes a
  // read of the PREVIOUS drug's code observable rather than merely theoretical.
  lookupRxcui: vi.fn(
    async (
      term: string
    ): Promise<{ rxcui: string; name: string; score: number }[]> =>
      /ibuprofen|advil|motrin/i.test(term)
        ? [{ rxcui: "5640", name: "Ibuprofen", score: 100 }]
        : /acetaminophen|tylenol/i.test(term)
          ? [{ rxcui: "161", name: "Acetaminophen", score: 100 }]
          : []
  ),
  lookupRxcuiIngredients: vi.fn(async (code: string) => [code]),
}));

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  addIntakeItem: actions.addIntakeItem,
  updateIntakeItem: vi.fn(async () => ({ ok: true })),
  lookupRxcui: actions.lookupRxcui,
  lookupRxcuiIngredients: actions.lookupRxcuiIngredients,
}));
vi.mock("@/app/(app)/trends/measurement-actions", () => ({
  addMeasurements: vi.fn(async () => ({ wrote: true })),
}));
vi.mock("@/lib/offline/draft-db", () => ({
  getDraft: actions.getDraft,
  putDraft: actions.putDraft,
  deleteDraft: vi.fn(async () => {}),
  purgeExpiredDrafts: vi.fn(async () => {}),
}));
vi.mock("@/app/(app)/supplies/actions", () => ({
  listSharedSupplyOptions: actions.listSharedSupplyOptions,
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

const BASE_LOOKUP = actions.lookupRxcui.getMockImplementation()!;

const TODAY = "2026-09-04";

// The two curated picker rows these tests choose between. Both resolve to an ingredient
// the #798 PRN dataset carries, and their label figures DIFFER — 4h/6 a day for
// acetaminophen against 6h/4 a day for ibuprofen — so a prefill attributed to the wrong
// one is visible as a number rather than as an absence.
const ACETAMINOPHEN = "Acetaminophen (Tylenol)";

/**
 * Open one of the shipped add doors. The doors are the mount, not IntakeItemForm
 * directly: the form's kind is locked at its five shipped call sites and a test that
 * mounted it itself would be a sixth (lib/__tests__/intake-form-kind-boundary.test.ts).
 */
function mount(
  kind: "medication" | "supplement",
  pediatric?: PediatricFormContext,
  drafts = false,
  initialSupply: SupplyOption | null = null
) {
  const content = (
    <ToastProvider>
      <ConfirmProvider>
        {kind === "medication" ? (
          <MedicationAddWorkspace
            subtitle=""
            action={actions.addIntakeItem}
            intakeContext={intakeFormContext(
              TODAY,
              pediatric ? { pediatric } : {}
            )}
            initialSupply={initialSupply}
          />
        ) : (
          <CreateAction
            declaration={{
              kind: "supplement",
              control: (
                <AddSupplementModal
                  action={actions.addIntakeItem}
                  intakeContext={intakeFormContext(
                    TODAY,
                    pediatric ? { pediatric } : {}
                  )}
                />
              ),
            }}
            housing="section"
          />
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
  const view = render(
    drafts ? (
      <ActiveProfileProvider profileId={1}>{content}</ActiveProfileProvider>
    ) : (
      content
    )
  );
  if (!initialSupply)
    fireEvent.click(
      screen.getByTestId(
        kind === "medication"
          ? "medication-add-toggle"
          : "supplement-add-toggle"
      )
    );
  return view;
}

/** Choose `option` from the one Name field — a PICK, not a keystroke. */
async function pickName(option: string) {
  const input = screen.getByRole("combobox", { name: "Name" });
  fireEvent.change(input, { target: { value: option.slice(0, 6) } });
  const row = await screen.findByRole("option", { name: option });
  fireEvent.mouseDown(row);
  // Let the pick's own async work (the RxNorm auto-confirm on a medication) settle, so
  // the NEXT pick reads a resolved code rather than racing the one under test.
  await act(async () => {});
}

/** Open one fact's editor by its chip. */
function openFact(key: string) {
  const done = screen.queryByTestId("intake-editor-done");
  if (done) fireEvent.click(done);
  const chip = screen.queryByTestId(`intake-fact-${key}`);
  if (chip) fireEvent.click(chip);
  else {
    fireEvent.click(screen.getByTestId("intake-fact-more"));
    fireEvent.click(screen.getByTestId(`intake-more-${key}`));
  }
  // New scheduled items begin with no dose row. Tests that operate a dose field state
  // that intent through the shipped Add dose control before editing the row.
  if (key === "dose" && !screen.queryByRole("combobox", { name: "Amount" }))
    fireEvent.click(screen.getByRole("button", { name: "Add dose" }));
}

const redoseFigures = () => ({
  interval: (screen.getByTestId("redose-interval") as HTMLInputElement).value,
  max: (screen.getByTestId("redose-max") as HTMLInputElement).value,
});

/** Switch the formulation chip row to `slug`. */
function pickFormulation(slug: string) {
  const pill = screen
    .getAllByTestId("intake-formulation-choice")
    .find((el) => el.getAttribute("data-slug") === slug);
  expect(pill, `no formulation chip for ${slug}`).toBeTruthy();
  fireEvent.click(pill!);
}

const PEDIATRIC_SLUG = "childrens_susp_160_5";

/**
 * Hold the RxNorm confirm open, so a pick can be inspected in the window where its own
 * code has not arrived yet — the window `onPickName` currently resolves the PRN entry in.
 */
function deferLookup() {
  let reject!: (reason: Error) => void;
  let release!: () => void;
  const gate = new Promise<void>((r, fail) => {
    release = r;
    reject = fail;
  });
  const real = actions.lookupRxcui.getMockImplementation()!;
  actions.lookupRxcui.mockImplementationOnce(async (term: string) => {
    await gate;
    return real(term);
  });
  return { resolve: release, reject: () => reject(new Error("offline")) };
}

/** Hold the authoritative bottle list across a restored draft's unresolved window. */
function deferSupplyOptions() {
  let release!: (options: SupplyOption[]) => void;
  const pending = new Promise<SupplyOption[]>((resolve) => {
    release = resolve;
  });
  actions.listSharedSupplyOptions.mockImplementationOnce(() => pending);
  return { resolve: release };
}

/** The recorded PRN resolutions for one drug name. */
const prnCallsFor = (name: string) =>
  prnSpy.calls.filter((call) => call.name === name);

beforeEach(() => {
  actions.getDraft.mockReset().mockResolvedValue(null);
  actions.putDraft.mockClear();
  actions.listSharedSupplyOptions.mockReset().mockResolvedValue([]);
  actions.addIntakeItem.mockClear();
  actions.lookupRxcui.mockClear();
  actions.lookupRxcuiIngredients.mockReset();
  actions.lookupRxcuiIngredients.mockImplementation(async (code) => [code]);
  actions.lookupRxcui.mockImplementation(BASE_LOOKUP);
  prnSpy.calls.length = 0;
});

it("keeps an unknown start when obligation changes and the medication is saved", async () => {
  mount("medication");
  fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
    target: { value: "Longstanding medicine" },
  });
  openFact("importance");
  for (const value of ["may", "must"]) {
    fireEvent.change(screen.getByLabelText("Obligation"), {
      target: { value },
    });
  }
  openFact("stopDate");
  const start = screen.getByLabelText(/Started on/) as HTMLInputElement;
  expect(start.value).toBe("");
  expect(start.required).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(actions.addIntakeItem).toHaveBeenCalledOnce());
  expect(actions.addIntakeItem.mock.calls[0]![0].get("started_on")).toBeNull();
});

describe("a formulation switch re-derives the product, never the person's numbers (#4665)", () => {
  // POSITIVE CONTROL. The same switch, on figures nobody typed, DOES write the child
  // label's preset — so the assertion below is about being touched, and not about a
  // chip row that never fired.
  it("writes the child label's preset over an untouched suggestion", async () => {
    mount("medication");
    await pickName(ACETAMINOPHEN);
    openFact("timing");
    // The adult label figures arrived as a suggestion from the pick itself.
    expect(redoseFigures()).toEqual({ interval: "4", max: "6" });
    pickFormulation(PEDIATRIC_SLUG);
    await waitFor(() =>
      expect(redoseFigures()).toEqual({ interval: "4", max: "5" })
    );
  });

  it("leaves hand-typed redose figures alone", async () => {
    mount("medication");
    await pickName(ACETAMINOPHEN);
    openFact("timing");
    fireEvent.change(screen.getByTestId("redose-interval"), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByTestId("redose-max"), {
      target: { value: "2" },
    });
    expect(redoseFigures()).toEqual({ interval: "8", max: "2" });

    pickFormulation(PEDIATRIC_SLUG);

    // The switch still happened — the product line follows the chip — but it did not
    // reach past the product to the caregiver's own numbers.
    await waitFor(() =>
      expect(screen.getByTestId("intake-pediatric-context")).toBeTruthy()
    );
    expect(redoseFigures()).toEqual({ interval: "8", max: "2" });
  });
});

describe("every seeded value is marked, whichever path seeded it (#4665, #846)", () => {
  // POSITIVE CONTROL. The medication arm marks what it seeds, so the badge is a thing
  // this form can render and this query can find.
  it("marks what the medication arm seeds", async () => {
    mount("medication");
    await pickName(ACETAMINOPHEN);
    await waitFor(() =>
      expect(screen.getAllByTestId("prefill-badge").length).toBeGreaterThan(0)
    );
  });

  it("marks what the catalog arm seeds", async () => {
    mount("supplement");
    await pickName("Vitamin C");
    // The catalog pick wrote a dose amount and a time of day onto the row.
    await waitFor(() =>
      expect(screen.getByTestId("intake-fact-dose").textContent).toContain(
        "250 mg"
      )
    );
    // So the row states them as OFFERS, not as facts the person supplied.
    expect(screen.getAllByTestId("prefill-badge").length).toBeGreaterThan(0);
  });
});

describe("one PRN computation per name resolution (#4665)", () => {
  // WHAT THIS PINS, and why it is a count. `onPickName` resolves the PRN entry itself,
  // from `rx.rxcui` as it stood in the render BEFORE the pick — a code the pick's own
  // `autoConfirm` has not produced yet — while the `prnDefaults` memo resolves the same
  // fact again from the code once it lands. Two computations of one fact, one of them
  // reading a pre-confirm value, is the defect; whether today's dataset happens to make
  // the two agree is not something the form should depend on.
  //
  // AND THIS IS A STRUCTURAL PIN ON PURPOSE, not a placeholder for a better one. With
  // the shipped dataset there is NO user-visible divergence to assert: every name whose
  // stale code resolves at all resolves to the same PRN entry the confirmed code does,
  // so both resolutions produce identical figures and no number on screen differs. The
  // count is what is observable. Do not delete it as an implementation detail — a form
  // that resolves the fact twice, once from a code that has not arrived, is one dataset
  // entry away from showing the previous drug's label figures, and this is the only
  // thing standing between here and there.
  //
  // The confirm is held open for the whole assertion, so what is counted is exactly the
  // resolution the PICK performed.
  it("resolves the picked drug's entry once, before the confirm lands", async () => {
    const confirmed = deferLookup();
    mount("medication");
    await pickName(ACETAMINOPHEN);

    const forPick = prnCallsFor("Acetaminophen");
    // POSITIVE CONTROL: the fact IS resolved by the pick — a count of zero would pass
    // an "at most once" assertion on a form that resolved nothing.
    expect(forPick.length).toBeGreaterThan(0);
    expect(forPick.length).toBe(1);
    // And nothing consulted a code the confirm had not yet returned.
    expect(forPick.every((call) => call.rxcui == null)).toBe(true);

    confirmed.resolve();
    await act(async () => {});
    // The confirm still lands and the entry is still the acetaminophen label.
    openFact("timing");
    expect(screen.getByTestId("redose-prefill").textContent).toContain(
      "4 hours"
    );
  });
});

// A LATE SEED DOSES AGAINST THE WEIGHT THAT STANDS, NOT THE ONE IT STARTED WITH
// (#5443).
//
// The pick awaits its RxNorm confirm before it seeds, and a caregiver can update the
// dosing weight inside that wait — the weight block sits in the same open dose editor.
// The new weight re-derives the label's offer as it lands, but there is no offer yet
// to withdraw, so the pick then wrote the OLD weight's band amount into a form the
// caregiver had already corrected: a milligram figure attributed to a measurement that
// no longer supports it, with the band picker showing it selected. It reached e2e as
// `medication-prefill.spec.ts:157` failing on `main` whenever the confirm ran long.
//
// The table is the two answers the NEW weight can give — no band at all, and a
// different band — because a fix that simply stopped seeding would pass the first row
// and fail the second. Both are asserted after the confirm lands, which is the moment
// the stale figure used to appear.
const CHILD_ON_PICK: PediatricFormContext = {
  ageMonths: 72,
  weightKg: 21, // 46 lb — the 36 lb band, 240 mg
  weightDate: TODAY,
  weightUnit: "kg",
  today: TODAY,
};

it("keeps an adolescent's dose blank when switching a refused chart's formulation", async () => {
  mount("medication", { ...CHILD_ON_PICK, ageMonths: 192, weightKg: 60 });
  await pickName(ACETAMINOPHEN);
  openFact("dose");
  expect(screen.getByTestId("pediatric-suggestion").textContent).toContain(
    "under 12 years"
  );
  expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
  expect(textbox("Amount").value).toBe("");
  pickFormulation("infant_susp_160_5");
  expect(textbox("Amount").value).toBe("");
});

/** Record a new dosing weight through the pediatric block's own control. */
async function updateDosingWeight(kg: string) {
  fireEvent.click(screen.getByTestId("pediatric-weight-update-open"));
  fireEvent.change(screen.getByTestId("pediatric-weight-input"), {
    target: { value: kg },
  });
  await act(async () => {
    fireEvent.click(
      within(screen.getByTestId("pediatric-weight-update")).getByRole(
        "button",
        {
          name: "Save",
        }
      )
    );
  });
}

/** What the dose editor states: the figure, and the label band shown as its source. */
const dosedAt = () => ({
  amount: (screen.getByRole("combobox", { name: "Amount" }) as HTMLInputElement)
    .value,
  bands: within(screen.getByTestId("pediatric-band-picker"))
    .getAllByRole("radio")
    .filter((radio) => (radio as HTMLInputElement).checked)
    .map((radio) => (radio as HTMLInputElement).value),
});

it("records an explicit pediatric band after a new weight withdraws the offered dose", async () => {
  mount("medication", CHILD_ON_PICK);
  await pickName(ACETAMINOPHEN);
  openFact("dose");
  expect(dosedAt()).toEqual({ amount: "240 mg", bands: ["36"] });

  await updateDosingWeight("10");
  expect(dosedAt()).toEqual({ amount: "", bands: [] });

  const firstBand = within(
    screen.getByTestId("pediatric-band-picker")
  ).getAllByRole("radio")[0];
  fireEvent.click(firstBand);
  expect(dosedAt()).toEqual({ amount: "160 mg", bands: ["24"] });

  // The explicit choice is now the caregiver's amount, not the new weight's offer.
  await updateDosingWeight("22");
  expect(textbox("Amount").value).toBe("160 mg");
});

describe("a pick that lands after a weight update doses against the new weight (#5443)", () => {
  it.each([
    // new weight, kg | amount after the confirm lands | band selected
    ["10", "", []], // 22 lb — below the 24 lb chart: no band, so no figure
    ["22", "320 mg", ["48"]], // 48 lb — the 48 lb band, never the 36 lb one it started on
  ])("weight %s kg leaves %s", async (kg, amount, bands) => {
    const confirmed = deferLookup();
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    openFact("dose");
    await updateDosingWeight(kg);
    // What the new weight decided, with the pick's confirm still in flight.
    expect(dosedAt()).toEqual({ amount, bands });

    confirmed.resolve();
    await act(async () => {});

    // And the confirm landing changes none of it. Without this the seed wrote the
    // 36 lb band's 240 mg — the weight the pick STARTED on — over both rows.
    expect(dosedAt()).toEqual({ amount, bands });
  });
});

// Exercise the complete lookup → confirmation lifetime through the shipped door.
// Holding the first stage catches identity writes that a prefill-only guard misses;
// holding decomposition catches same-code operations that a code comparison misses.
describe("product identity owns every pending RxNorm stage (#5518)", () => {
  it.each(["resolve", "reject"] as const)(
    "a typed replacement ignores an old lookup that %ss",
    async (settle) => {
      const old = deferLookup();
      mount("medication", CHILD_ON_PICK);
      await pickName(ACETAMINOPHEN);
      fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
        target: { value: "Vicodin" },
      });
      openFact("dose");
      expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
      await act(async () => old[settle]());
      expect(screen.getByRole("combobox", { name: "Name" })).toHaveProperty(
        "value",
        "Vicodin"
      );
      expect(screen.queryByTestId("rxcui-current")).toBeNull();
      expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
      expect(screen.getByRole("combobox", { name: "Amount" })).toHaveProperty(
        "value",
        ""
      );
    }
  );

  it("a newer pick keeps its own code and dose when the old lookup lands", async () => {
    const old = deferLookup();
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    await pickName("Ibuprofen (Advil, Motrin)");
    openFact("dose");
    expect(screen.getByTestId("rxcui-current").textContent).toContain("5640");
    expect(dosedAt().amount).toBe("150 mg");
    await act(async () => old.resolve());
    expect(screen.getByTestId("rxcui-current").textContent).toContain("5640");
    expect(dosedAt().amount).toBe("150 mg");
  });

  it.each(["resolve", "reject"] as const)(
    "an obsolete manual lookup cannot publish candidates, errors or completion when it %ss",
    async (settle) => {
      const old = deferLookup();
      mount("medication", CHILD_ON_PICK);
      const name = screen.getByRole("combobox", { name: "Name" });
      fireEvent.change(name, { target: { value: "Acetaminophen" } });
      fireEvent.click(screen.getByTestId("rxcui-lookup"));
      fireEvent.change(name, { target: { value: "Ibuprofen" } });
      const current = deferLookup();
      fireEvent.click(screen.getByTestId("rxcui-lookup"));
      await act(async () => old[settle]());
      expect(screen.getByTestId("rxcui-lookup").textContent).toBe(
        "Looking up…"
      );
      expect(screen.queryByTestId("rxcui-candidates")).toBeNull();
      expect(screen.queryByText(/Couldn't reach the RxNorm lookup/)).toBeNull();
      await act(async () => current.resolve());
      expect(screen.getByTestId("rxcui-use-5640")).toBeTruthy();
      expect(screen.queryByTestId("rxcui-use-161")).toBeNull();
    }
  );

  it("returning to the same code cannot accept an older ingredient response", async () => {
    let release!: (ingredients: string[]) => void;
    actions.lookupRxcuiIngredients.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    await pickName("Ibuprofen (Advil, Motrin)");
    await pickName(ACETAMINOPHEN);
    openFact("dose");
    expect(dosedAt().amount).toBe("240 mg");
    await act(async () => release(["161", "2670"]));
    expect(screen.getByTestId("rxcui-current").textContent).toContain("161");
    expect(dosedAt().amount).toBe("240 mg");
  });

  it.each(["no match", "offline"])(
    "a current %s lookup still seeds the supported plain-name dose",
    async (outcome) => {
      if (outcome === "offline")
        actions.lookupRxcui.mockRejectedValueOnce(new Error("offline"));
      else actions.lookupRxcui.mockResolvedValueOnce([]);
      mount("medication", CHILD_ON_PICK);
      await pickName(ACETAMINOPHEN);
      openFact("dose");
      expect(screen.queryByTestId("rxcui-current")).toBeNull();
      expect(dosedAt().amount).toBe("240 mg");
    }
  );

  it("an explicit supplement composition edit invalidates pending confirmation", async () => {
    let release!: (ingredients: string[]) => void;
    actions.lookupRxcuiIngredients.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    mount("supplement");
    fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
      target: { value: "Acetaminophen" },
    });
    await act(async () => fireEvent.click(screen.getByTestId("rxcui-lookup")));
    await act(async () => fireEvent.click(screen.getByTestId("rxcui-use-161")));
    openFact("composition");
    fireEvent.click(screen.getByTestId("add-ingredients"));
    fireEvent.change(screen.getByTestId("ingredient-name-0"), {
      target: { value: "Codeine" },
    });
    await act(async () => release(["161"]));
    expect(screen.queryByTestId("rxcui-current")).toBeNull();
  });

  it("clearing a confirmed code invalidates its pending ingredient response and prefill", async () => {
    let release!: (ingredients: string[]) => void;
    actions.lookupRxcuiIngredients.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    fireEvent.click(screen.getByTestId("rxcui-clear"));
    await act(async () => release(["161"]));
    openFact("dose");
    expect(screen.queryByTestId("rxcui-current")).toBeNull();
    expect(dosedAt().amount).toBe("");
  });

  it.each(["name", "supply"])(
    "the %s bottle picker retires the older lookup",
    async (door) => {
      actions.listSharedSupplyOptions.mockResolvedValue([
        {
          id: 99,
          name: "Acetaminophen with Codeine",
          strength: null,
          form: null,
          siblingKind: "medication",
        },
      ]);
      const old = deferLookup();
      mount("medication", CHILD_ON_PICK);
      await pickName(ACETAMINOPHEN);
      if (door === "name") {
        actions.lookupRxcui.mockResolvedValueOnce([
          { rxcui: "99999", name: "Acetaminophen with Codeine", score: 100 },
        ]);
        actions.lookupRxcuiIngredients.mockResolvedValueOnce(["161", "2670"]);
        await pickName("Acetaminophen with Codeine — shared bottle");
      } else {
        openFact("supply");
        fireEvent.change(screen.getByTestId("shared-supply-new-item-select"), {
          target: { value: "99" },
        });
      }
      await act(async () => old.resolve());
      openFact("dose");
      if (door === "name")
        expect(screen.getByTestId("rxcui-current").textContent).toContain(
          "99999"
        );
      else expect(screen.queryByTestId("rxcui-current")).toBeNull();
      expect(screen.getByRole("combobox", { name: "Amount" })).toHaveProperty(
        "value",
        ""
      );
      expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
      if (door === "supply") {
        openFact("supply");
        fireEvent.change(screen.getByTestId("shared-supply-new-item-select"), {
          target: { value: "" },
        });
        openFact("dose");
        await waitFor(() =>
          expect(screen.getByTestId("pediatric-band-picker")).toBeTruthy()
        );
      }
    }
  );

  it("saves a linked combination bottle without replacing the item display name", async () => {
    actions.listSharedSupplyOptions.mockResolvedValue([
      {
        id: 99,
        name: "Acetaminophen with Codeine",
        strength: null,
        form: null,
        siblingKind: "medication",
      },
    ]);
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    openFact("supply");
    fireEvent.change(screen.getByTestId("shared-supply-new-item-select"), {
      target: { value: "99" },
    });
    openFact("dose");
    expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(actions.addIntakeItem).toHaveBeenCalledOnce());
    const saved = actions.addIntakeItem.mock.calls[0]![0];
    expect(saved.get("name")).toBe("Acetaminophen");
    expect(saved.get("supply_id")).toBe("99");
    expect(saved.get("rxcui")).toBe("");
    expect(JSON.parse(String(saved.get("doses")))).toEqual([]);
  });

  it("submits no dose row until one is added", async () => {
    mount("supplement");
    fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
      target: { value: "Plain supplement" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(actions.addIntakeItem).toHaveBeenCalledOnce());
    const saved = actions.addIntakeItem.mock.calls[0]![0];
    expect(JSON.parse(String(saved.get("doses")))).toEqual([]);
  });

  it("submits a nonblank dose offered by an explicit medication pick", async () => {
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(actions.addIntakeItem).toHaveBeenCalledOnce());
    const saved = actions.addIntakeItem.mock.calls[0]![0];
    expect(JSON.parse(String(saved.get("doses")))[0]?.amount).toBe("240 mg");
  });

  it("submits the visible PRN amount from an initial shared bottle", async () => {
    mount("medication", undefined, false, {
      id: 22,
      name: "Ibuprofen",
      strength: "200 mg",
      form: "tablet",
      siblingKind: "medication",
    });
    openFact("dose");
    expect(textbox("Amount").value).toBe("200 mg");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(actions.addIntakeItem).toHaveBeenCalledOnce());
    const saved = actions.addIntakeItem.mock.calls[0]![0];
    expect(JSON.parse(String(saved.get("doses")))[0]?.amount).toBe("200 mg");
  });

  it("does not claim or clear a manual amount when a bottle is linked then unlinked", async () => {
    actions.listSharedSupplyOptions.mockResolvedValue([
      {
        id: 98,
        name: "Ibuprofen",
        strength: "200 mg",
        form: "tablet",
        siblingKind: "medication",
      },
    ]);
    mount("medication");
    await pickName(ACETAMINOPHEN);
    openFact("dose");
    fireEvent.change(textbox("Amount"), { target: { value: "12.5 mg" } });

    openFact("supply");
    fireEvent.change(screen.getByTestId("shared-supply-new-item-select"), {
      target: { value: "98" },
    });
    openFact("dose");
    expect(textbox("Amount").value).toBe("12.5 mg");

    openFact("supply");
    fireEvent.change(screen.getByTestId("shared-supply-new-item-select"), {
      target: { value: "" },
    });
    openFact("dose");
    expect(textbox("Amount").value).toBe("12.5 mg");
  });

  it("uses a supported bottle name when the item display name differs", async () => {
    actions.listSharedSupplyOptions.mockResolvedValue([
      {
        id: 98,
        name: "Ibuprofen",
        strength: null,
        form: null,
        siblingKind: "medication",
      },
    ]);
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    openFact("supply");
    fireEvent.change(screen.getByTestId("shared-supply-new-item-select"), {
      target: { value: "98" },
    });
    expect(screen.getByRole("combobox", { name: "Name" })).toHaveProperty(
      "value",
      "Acetaminophen"
    );
    openFact("dose");
    expect(screen.getByTestId("pediatric-suggestion").textContent).toContain(
      "Ibuprofen"
    );
    expect(screen.getByTestId("pediatric-band-picker")).toBeTruthy();
  });

  it.each([
    {
      bottle: {
        id: 99,
        name: "Acetaminophen with Codeine",
        strength: null,
        form: null,
        siblingKind: "medication" as const,
      },
      restoredAmount: "180 mg",
      confirmedIngredient: false,
      supported: false,
    },
    {
      bottle: {
        id: 98,
        name: "Ibuprofen",
        strength: null,
        form: null,
        siblingKind: "medication" as const,
      },
      restoredAmount: "175 mg",
      confirmedIngredient: true,
      supported: true,
    },
  ])(
    "restores a draft linked to the $bottle.name bottle before delayed options arrive",
    async ({ bottle, restoredAmount, confirmedIngredient, supported }) => {
      actions.listSharedSupplyOptions.mockResolvedValue([bottle]);
      const first = mount("medication", CHILD_ON_PICK, true);
      await pickName(ACETAMINOPHEN);
      openFact("supply");
      await screen.findByRole("option", { name: bottle.name });
      fireEvent.change(screen.getByTestId("shared-supply-new-item-select"), {
        target: { value: String(bottle.id) },
      });
      if (confirmedIngredient) {
        await pickName(ACETAMINOPHEN);
        await waitFor(() =>
          expect(screen.getByTestId("rxcui-current").textContent).toContain(
            "161"
          )
        );
      } else await act(async () => {});
      openFact("dose");
      fireEvent.change(screen.getByRole("combobox", { name: "Amount" }), {
        target: { value: restoredAmount },
      });
      expect(screen.getByRole("combobox", { name: "Name" })).toHaveProperty(
        "value",
        "Acetaminophen"
      );
      expect(Boolean(screen.queryByTestId("pediatric-band-picker"))).toBe(
        supported
      );
      first.unmount();
      await waitFor(() => expect(actions.putDraft).toHaveBeenCalled());
      const saved = actions.putDraft.mock.calls.at(-1)![0];
      expect(
        (saved.extra as { state: { supplyId: string } }).state.supplyId
      ).toBe(String(bottle.id));
      actions.getDraft.mockResolvedValue(saved);

      const delayed = deferSupplyOptions();
      mount("medication", CHILD_ON_PICK, true);
      fireEvent.click(await screen.findByTestId("draft-restore-resume"));
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Name" })).toHaveProperty(
          "value",
          "Acetaminophen"
        )
      );
      openFact("dose");
      expect(Boolean(screen.queryByTestId("pediatric-band-picker"))).toBe(
        supported
      );
      if (supported) {
        expect(
          screen.getByTestId("pediatric-suggestion").textContent
        ).toContain("Acetaminophen");
        expect(screen.getByTestId("rxcui-current").textContent).toContain(
          "161"
        );
      }
      expect(screen.getByRole("combobox", { name: "Amount" })).toHaveProperty(
        "value",
        restoredAmount
      );

      const resumedBottle = supported
        ? { ...bottle, siblingKind: "supplement" as const }
        : bottle;
      await act(async () => delayed.resolve([resumedBottle]));
      openFact("supply");
      expect(
        await screen.findByRole("option", { name: bottle.name })
      ).toHaveProperty("selected", true);
      openFact("dose");
      if (supported) {
        expect(
          screen.getByTestId("pediatric-suggestion").textContent
        ).toContain("Acetaminophen");
        expect(screen.getByTestId("pediatric-band-picker")).toBeTruthy();
      } else {
        expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
      }
      expect(screen.getByRole("combobox", { name: "Amount" })).toHaveProperty(
        "value",
        restoredAmount
      );
    }
  );

  it.each([
    ["stated", "180 mg"],
    ["cleared", ""],
  ])(
    "restoring a draft preserves its identity and %s personal dose after an old lookup lands",
    async (_kind, restoredAmount) => {
      const first = mount("medication", CHILD_ON_PICK, true);
      await pickName("Ibuprofen (Advil, Motrin)");
      openFact("dose");
      fireEvent.change(screen.getByRole("combobox", { name: "Amount" }), {
        target: { value: restoredAmount },
      });
      first.unmount();
      const saved = actions.putDraft.mock.calls.at(-1)![0];
      expect(saved).toBeTruthy();
      actions.getDraft.mockResolvedValue(saved);
      mount("medication", CHILD_ON_PICK, true);
      await screen.findByTestId("draft-restore-resume");
      // Positive control: this still is a fresh form until Resume is accepted, so the
      // supported pediatric suggestion must be able to seed it.
      await pickName(ACETAMINOPHEN);
      openFact("dose");
      expect(dosedAt().amount).toBe("240 mg");
      const old = deferLookup();
      await pickName(ACETAMINOPHEN);
      fireEvent.click(screen.getByTestId("draft-restore-resume"));
      await act(async () =>
        fireEvent.click(
          within(screen.getByTestId("confirm-dialog")).getByRole("button", {
            name: "Resume",
          })
        )
      );
      await act(async () => old.resolve());
      expect(screen.getByRole("combobox", { name: "Name" })).toHaveProperty(
        "value",
        "Ibuprofen"
      );
      expect(screen.getByTestId("rxcui-current").textContent).toContain("5640");
      expect(dosedAt().amount).toBe(restoredAmount);
      // A later supported pick may replace product identity, but not the personal amount
      // restored from the draft.
      await pickName(ACETAMINOPHEN);
      expect(screen.getByTestId("rxcui-current").textContent).toContain("161");
      expect(dosedAt().amount).toBe(restoredAmount);
      // The current name-only fallback offers the same label dose and is refused by the
      // same restored ownership.
      actions.lookupRxcui.mockResolvedValueOnce([]);
      await pickName(ACETAMINOPHEN);
      expect(screen.queryByTestId("rxcui-current")).toBeNull();
      expect(dosedAt().amount).toBe(restoredAmount);
      fireEvent.click(screen.getByTestId("intake-editor-done"));
      expect(screen.getByTestId("intake-fact-dose").textContent).not.toContain(
        "from label defaults"
      );
      openFact("dose");
      // A restored amount is personal state, not the prior live label's offer.
      fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
        target: { value: "Vicodin" },
      });
      expect(screen.getByRole("combobox", { name: "Amount" })).toHaveProperty(
        "value",
        restoredAmount
      );
    }
  );

  it("unmounting the form retires the pending pick before it resolves a label", async () => {
    const old = deferLookup();
    const view = mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    view.unmount();
    const calls = prnSpy.calls.length;
    await act(async () => old.resolve());
    expect(prnSpy.calls).toHaveLength(calls);
  });

  it("manual confirmation supersedes an older automatic lookup", async () => {
    const old = deferLookup();
    mount("medication", CHILD_ON_PICK);
    await pickName(ACETAMINOPHEN);
    actions.lookupRxcui.mockResolvedValueOnce([
      { rxcui: "99999", name: "Acetaminophen with Codeine", score: 100 },
    ]);
    actions.lookupRxcuiIngredients.mockResolvedValueOnce(["161", "2670"]);
    await act(async () => fireEvent.click(screen.getByTestId("rxcui-lookup")));
    await act(async () =>
      fireEvent.click(screen.getByTestId("rxcui-use-99999"))
    );
    await act(async () => old.resolve());
    openFact("dose");
    expect(screen.getByTestId("rxcui-current").textContent).toContain("99999");
    expect(screen.queryByTestId("pediatric-band-picker")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Amount" })).toHaveProperty(
      "value",
      ""
    );
  });
});

// ── THE CENSUS: every prefillable field's control marks the ledger ────────────
//
// The three cases above prove three reported divergences are gone, and
// lib/__tests__/intake-prefill.test.ts proves the ledger refuses a field it has been
// TOLD the person touched. Neither proves the thing that was actually broken: that
// each field's control tells it. Bug 1 was exactly that omission — a hand-typed redose
// figure was overwritable because the control that set it marked nothing — so a rule
// that is only as good as its wiring needs the wiring walked, not sampled.
//
// This walks `PREFILL_FIELDS` and, per field, drives that field's REAL control and
// then picks a second label that states the same field. Whatever the person put there
// has to still be there.
//
// WHY THIS TIER AND NOT A SOURCE SCAN over `touchPrefill` call sites. `foodTiming` has
// no call of its own to find: its control is the rules builder, and its marking goes
// through one wrapper around that builder's setter. A scan counting the six field
// names against call sites would be green with that wrapper wired to nothing, which is
// the same shape of hole as the bug. Reading the control back is the check that cannot
// be satisfied by a mark nobody reaches.
//
// HOW THIS FAILS RATHER THAN SKIPS.
//  - The table is a total `Record<PrefillField, …>`, so a seventh field cannot join the
//    enumeration without joining this file.
//  - The floor case pins the population, so an emptied enumeration cannot generate
//    zero cases and report that as green.
//  - Every control is fetched with a throwing query, so a field whose control this
//    cannot find fails; it is never skipped.
//  - Every field carries a POSITIVE CONTROL — the same re-seed, with nothing edited,
//    DOES write its value — so "their value stood" can never be a re-seed that stated
//    nothing at all.

/** How one prefillable field is driven, end to end, through the shipped form. */
interface ControlCase {
  /** A first pick, after which this field's control holds `offered`. */
  seed: string;
  /** Put this field's own control on screen. */
  open: () => void;
  /** Read that control back. */
  read: () => string;
  offered: string;
  /** The person's edit, made through that same control. */
  edit: () => void;
  edited: string;
  /** A second pick whose label states this field — and states it differently. */
  reseed: string;
  reoffered: string;
}

const select = (name: string) =>
  screen.getByRole("combobox", { name }) as HTMLSelectElement;
const textbox = (name: string) =>
  screen.getByRole("combobox", { name }) as HTMLInputElement;
const field = (testId: string) =>
  screen.getByTestId(testId) as HTMLInputElement;

/** Open the rules builder through the food rule's own chip. */
function openFoodRule() {
  const chip = screen.getAllByTestId("intake-fact-rule")[0];
  fireEvent.click(within(chip).getAllByRole("button")[0]);
}

/**
 * The food timing the form would SAVE. `fieldsFromRules` reads the food sentences in
 * list order and keeps the last, and a seed appends its suggested rule to the end — so
 * reading the first select would report the person's rule as standing while the label's
 * rule, added after it, is the one that wins.
 */
function savedFoodTiming(): string {
  const all = screen.getAllByRole("combobox", {
    name: "Food timing",
  }) as HTMLSelectElement[];
  return all[all.length - 1].value;
}

// The labels these cases pick between, and why each pair. Every pair states the field
// under test in BOTH picks and states it differently, so the re-seed winning and the
// person's edit standing are two different readings of the same control.
const CENSUS: Record<PrefillField, ControlCase> = {
  // Ibuprofen's label is as-needed; simvastatin's is not.
  asNeeded: {
    seed: "Simvastatin (Zocor)",
    open: () => openFact("importance"),
    read: () => field("intake-obligation").value,
    offered: "must",
    edit: () =>
      fireEvent.change(field("intake-obligation"), {
        target: { value: "should" },
      }),
    edited: "should",
    reseed: "Ibuprofen (Advil, Motrin)",
    reoffered: "may",
  },
  // The two OTC label figures this file already leans on: 500 mg against 200 mg.
  doseAmount: {
    seed: ACETAMINOPHEN,
    open: () => openFact("dose"),
    read: () => textbox("Amount").value,
    offered: "500 mg",
    edit: () =>
      fireEvent.change(textbox("Amount"), { target: { value: "12.5 mg" } }),
    edited: "12.5 mg",
    reseed: "Ibuprofen (Advil, Motrin)",
    reoffered: "200 mg",
  },
  // Acetaminophen redoses every 4 h up to 6 a day; ibuprofen every 6 h up to 4.
  minIntervalHours: {
    seed: ACETAMINOPHEN,
    open: () => openFact("timing"),
    read: () => field("redose-interval").value,
    offered: "4",
    edit: () =>
      fireEvent.change(field("redose-interval"), { target: { value: "8" } }),
    edited: "8",
    reseed: "Ibuprofen (Advil, Motrin)",
    reoffered: "6",
  },
  maxDailyCount: {
    seed: ACETAMINOPHEN,
    open: () => openFact("timing"),
    read: () => field("redose-max").value,
    offered: "6",
    edit: () =>
      fireEvent.change(field("redose-max"), { target: { value: "2" } }),
    edited: "2",
    reseed: "Ibuprofen (Advil, Motrin)",
    reoffered: "4",
  },
  // Statins are evening drugs, levothyroxine a morning one. Neither is as-needed, so
  // the dose row keeps its time-of-day control.
  timeOfDay: {
    seed: "Simvastatin (Zocor)",
    open: () => openFact("dose"),
    read: () => select("Time of day").value,
    offered: "Evening",
    edit: () =>
      fireEvent.change(select("Time of day"), {
        target: { value: "Before sleep" },
      }),
    edited: "Before sleep",
    reseed: "Levothyroxine (Synthroid, Levoxyl, …)",
    reoffered: "Morning",
  },
  // Levothyroxine is an empty-stomach drug, metformin a with-food one.
  foodTiming: {
    seed: "Levothyroxine (Synthroid, Levoxyl, …)",
    open: openFoodRule,
    read: savedFoodTiming,
    offered: "empty_stomach",
    edit: () =>
      fireEvent.change(
        screen.getByRole("combobox", {
          name: "Food timing",
        }) as HTMLSelectElement,
        { target: { value: "before_meal" } }
      ),
    edited: "before_meal",
    reseed: "Metformin (Glucophage)",
    reoffered: "with_food",
  },
};

describe("every prefillable field's control marks the ledger (#4665)", () => {
  // THE FLOOR. The cases below are generated from the enumeration, and a loop over an
  // empty enumeration is a green suite that asserted nothing — the failure this census
  // exists to prevent, in the census itself. Six fields today; this number moves when
  // someone has added a field AND its case.
  it("walks all six prefillable fields", () => {
    expect(PREFILL_FIELDS.length).toBe(6);
  });

  for (const name of PREFILL_FIELDS) {
    const c = CENSUS[name];

    // POSITIVE CONTROL. The re-seed really does state this field, so the assertion
    // below is about the ledger refusing it and not about a pick that offered nothing.
    it(`${name}: the second label states it, over an untouched value`, async () => {
      mount("medication");
      await pickName(c.seed);
      c.open();
      expect(c.read()).toBe(c.offered);

      await pickName(c.reseed);

      await waitFor(() => expect(c.read()).toBe(c.reoffered));
    });

    it(`${name}: a value the person set is not written over`, async () => {
      mount("medication");
      await pickName(c.seed);
      c.open();
      c.edit();
      expect(c.read()).toBe(c.edited);

      await pickName(c.reseed);

      expect(c.read()).toBe(c.edited);
    });
  }
});

describe("add-form supply offer stays local until Save", () => {
  it("can be declined at the front door, then saves the once-asked intent without a count or dose", async () => {
    mount("supplement");
    fireEvent.change(screen.getByRole("combobox", { name: "Name" }), {
      target: { value: "Unlisted supply item" },
    });
    fireEvent.click(screen.getByTestId("offer-decline-track-supply"));
    await waitFor(() =>
      expect(screen.queryByTestId("offer-track-supply")).toBeNull()
    );
    expect(actions.addIntakeItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(actions.addIntakeItem).toHaveBeenCalledOnce());
    const posted = actions.addIntakeItem.mock.calls[0][0];
    expect(posted.get("supply_offer_seen")).toBe("1");
    expect(posted.get("quantity_on_hand")).toBe("");
    expect(JSON.parse(String(posted.get("doses")))).toEqual([]);
  });

  it("accepting the count and then cancelling creates no item", async () => {
    mount("supplement");
    fireEvent.change(screen.getByLabelText("How many are left?"), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByTestId("offer-accept-track-supply"));
    await waitFor(() =>
      expect(screen.getByTestId("intake-fact-supply").textContent).toContain(
        "60 on hand"
      )
    );
    expect(actions.addIntakeItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(actions.addIntakeItem).not.toHaveBeenCalled();
  });
});
