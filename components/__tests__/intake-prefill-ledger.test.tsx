import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import IntakeItemForm from "@/components/IntakeItemForm";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ToastProvider } from "@/components/Toast";
import type { IntakeItemKind } from "@/lib/types";

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
  const real =
    await importOriginal<typeof import("@/lib/prn-defaults")>();
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

const BASE_LOOKUP = actions.lookupRxcui.getMockImplementation()!;

const TODAY = "2026-09-04";

// The two curated picker rows these tests choose between. Both resolve to an ingredient
// the #798 PRN dataset carries, and their label figures DIFFER — 4h/6 a day for
// acetaminophen against 6h/4 a day for ibuprofen — so a prefill attributed to the wrong
// one is visible as a number rather than as an absence.
const ACETAMINOPHEN = "Acetaminophen (Tylenol)";

function mount(kind: IntakeItemKind) {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <IntakeItemForm
          action={actions.addIntakeItem}
          kind={kind}
          todayStr={TODAY}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
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
  fireEvent.click(screen.getByTestId(`intake-fact-${key}`));
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
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const real = actions.lookupRxcui.getMockImplementation()!;
  actions.lookupRxcui.mockImplementation(async (term: string) => {
    await gate;
    return real(term);
  });
  return { resolve: release };
}

/** The recorded PRN resolutions for one drug name. */
const prnCallsFor = (name: string) =>
  prnSpy.calls.filter((call) => call.name === name);

beforeEach(() => {
  actions.addIntakeItem.mockClear();
  actions.lookupRxcui.mockClear();
  actions.lookupRxcuiIngredients.mockClear();
  actions.lookupRxcui.mockImplementation(BASE_LOOKUP);
  prnSpy.calls.length = 0;
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
