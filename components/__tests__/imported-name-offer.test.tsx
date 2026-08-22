import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import ImportedNameOffer from "../import/ImportedNameOffer";

// THE OFFER'S OWN CONTENT (#3480), and the reason this file exists at all.
//
// `ImportedNameOffer` is where the doctrine's central sentence is actually kept: "no
// stored name changes without a person seeing BOTH VERSIONS and choosing". Every word
// of that is a claim about this component's DOM — the document's wording is on
// screen, there is a control that accepts a replacement, and once one is accepted the
// row still says what the document called it.
//
// NOTHING COULD SEE ANY OF IT. It is a client component, so the server-tier render
// test (`lib/__action_tests__/imported-names-card.render.test.ts`) walks the tree and
// finds an unrendered element carrying PROPS — which is the right assertion for the
// question that file asks (is the card handed the right rows, on the right tab) and
// is structurally incapable of answering this one. All three of these mutations
// passed every tier before this file:
//
//   * delete the `{name}` span, so the offer stops showing the current name;
//   * delete the "Use this name" button, so nothing can be accepted;
//   * delete the `sourceName &&` block, so what the document said disappears.
//
// WHY THIS TIER AND NOT PLAYWRIGHT. docs/internals/component-tests.md says not to
// reach here for "does this page paint", and this is not that: the subject is one
// client component's own DOM, with no Server/Client boundary inside it, so what jsdom
// renders is what a browser renders. The alternative was a new e2e spec — which
// re-partitions all twelve shards (see the brief) and would need a seeded portal
// document carrying a document-string medication — to observe three elements.
//
// WHAT IS MOCKED, and it is only the module boundary this component already talks
// over: the two Server Actions, the router and the toast. The component's own logic —
// the `isCleanerName` filter over what RxNorm returned, the loading and busy copy,
// the conditional blocks — is the real thing.
//
// THE ADOPT MOCK ANSWERS THREE WAYS, and the first version of this file answered only
// one. A stub that always returns `{ok: true}` cannot observe either failure branch,
// and `use()` had a `try … finally` with NO `catch`: a Server Action that REJECTS —
// offline, a 500, a deploy mid-click — produced an unhandled rejection, the button
// un-busied, and nothing on screen told the person the rename had not happened. The
// `{ok:false}` branch was equally unobserved. Both are driven below, and the toast is
// a SHARED spy so what the person was told is an assertion rather than an assumption.

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  lookupRxcui: vi.fn(async () => [
    // One usable concept and one that is itself a document string, so the
    // `isCleanerName` filter has something to do.
    { rxcui: "2418", name: "Cholecalciferol" },
    { rxcui: "9999", name: "VITAMIN D3 1000 UNIT CAP" },
  ]),
}));

// The payload the component posted, captured rather than inferred: what the action
// is HANDED is the whole of what this component decides.
const adoptedPayloads: FormData[] = [];

// How the action answers this test. Reassigned per case rather than re-mocked, so the
// three outcomes a person can actually meet are all reachable from one module mock.
type AdoptAnswer = () => Promise<{ ok: true } | { ok: false; error: string }>;
let adoptAnswer: AdoptAnswer = async () => ({ ok: true });

const adopt = vi.fn(async (fd: FormData) => {
  adoptedPayloads.push(fd);
  return adoptAnswer();
});
vi.mock("@/app/(app)/import/name-actions", () => ({
  adoptImportedMedicationName: (fd: FormData) => adopt(fd),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// One spy for every render, so a test can read what the person was told. `useToast`
// returning a fresh `vi.fn()` per call — the first version here — is unobservable.
const toasted: [string, { tone?: string } | undefined][] = [];
vi.mock("@/components/Toast", () => ({
  useToast: () => (message: string, opts?: { tone?: string }) => {
    toasted.push([message, opts]);
  },
}));

beforeEach(() => {
  adoptAnswer = async () => ({ ok: true });
  adoptedPayloads.length = 0;
  toasted.length = 0;
});

function offer(props: { name: string; sourceName: string | null }) {
  render(
    <ImportedNameOffer
      itemId={7}
      documentId={4}
      name={props.name}
      sourceName={props.sourceName}
    />
  );
}

const DOCUMENT_STRING = "VITAMIN D3";

describe("the offer shows the name the document used", () => {
  it("renders the stored name as text, not only as a prop", () => {
    offer({ name: DOCUMENT_STRING, sourceName: null });
    expect(screen.getByTestId("imported-name-current").textContent).toBe(
      DOCUMENT_STRING
    );
  });

  it("renders it as stored — no casing pass on the way to the DOM", () => {
    // The other half of the doctrine, asserted where it lands rather than only in
    // the source census: a portal string reaches the screen shouting, because that
    // is what the document said, and the person decides what to do about it.
    offer({
      name: "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)",
      sourceName: null,
    });
    expect(screen.getByTestId("imported-name-current").textContent).toBe(
      "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)"
    );
  });

  it("offers no replacement until somebody asks for one", () => {
    offer({ name: DOCUMENT_STRING, sourceName: null });
    expect(screen.queryByTestId("imported-name-candidates")).toBeNull();
    expect(screen.getByTestId("imported-name-find").textContent).toBe(
      "Find a clearer name"
    );
  });
});

describe("both versions are on screen before anything is accepted", () => {
  it("names the concept and gives it an accept control", async () => {
    offer({ name: DOCUMENT_STRING, sourceName: null });
    await act(async () => {
      screen.getByTestId("imported-name-find").click();
    });
    // The person sees the candidate's own name beside the name they have now —
    // both versions, which is the whole condition on changing one.
    const list = screen.getByTestId("imported-name-candidates");
    expect(list.textContent).toContain("Cholecalciferol");
    expect(screen.getByTestId("imported-name-current").textContent).toBe(
      DOCUMENT_STRING
    );
    const use = screen.getByTestId("imported-name-use-2418");
    expect(use.textContent).toBe("Use this name");
  });

  it("does not offer a candidate that is itself a document string", () => {
    // `isCleanerName` runs for real here. Trading a document string for a document
    // string is not a fix, and the stub returns one on purpose.
    offer({ name: DOCUMENT_STRING, sourceName: null });
    return act(async () => {
      screen.getByTestId("imported-name-find").click();
    }).then(() => {
      expect(screen.queryByTestId("imported-name-use-9999")).toBeNull();
    });
  });

  it("sends the concept the person pressed, for this row and this document", async () => {
    offer({ name: DOCUMENT_STRING, sourceName: null });
    await act(async () => {
      screen.getByTestId("imported-name-find").click();
    });
    await act(async () => {
      screen.getByTestId("imported-name-use-2418").click();
    });
    expect(adoptedPayloads).toHaveLength(1);
    expect(Object.fromEntries(adoptedPayloads[0].entries())).toEqual({
      item_id: "7",
      document_id: "4",
      rxcui: "2418",
      name: "Cholecalciferol",
    });
  });
});

describe("what the document said survives the rename on screen", () => {
  it("shows the kept label once a name has been accepted", () => {
    offer({ name: "Cholecalciferol", sourceName: DOCUMENT_STRING });
    expect(screen.getByTestId("imported-name-kept").textContent).toBe(
      `Imported as “${DOCUMENT_STRING}”`
    );
    expect(screen.getByTestId("imported-name-current").textContent).toBe(
      "Cholecalciferol"
    );
  });

  it("says nothing about a kept label before there is one", () => {
    // Paired with the case above, because this is an ABSENCE and a component that
    // failed to mount at all would report the same thing.
    offer({ name: DOCUMENT_STRING, sourceName: null });
    expect(screen.queryByTestId("imported-name-kept")).toBeNull();
    expect(screen.getByTestId("imported-name-current").textContent).toBe(
      DOCUMENT_STRING
    );
  });
});

describe("the moment of choosing says what accepting costs", () => {
  it("names the consequence beside the candidates, not before them", async () => {
    // A person pressing "Use this name" is renaming the row the nutrient and
    // interaction checks key on, so the offer must not read as free. It belongs
    // HERE — with both names on screen and a button under it — and not as a standing
    // line on a card somebody scrolls past.
    offer({ name: DOCUMENT_STRING, sourceName: null });
    expect(screen.queryByTestId("imported-name-consequence")).toBeNull();
    await act(async () => {
      screen.getByTestId("imported-name-find").click();
    });
    expect(screen.getByTestId("imported-name-consequence").textContent).toBe(
      "Any warnings on this med follow its name — a new name can change them."
    );
  });
});

describe("a rename that does not happen says so", () => {
  // NEITHER BRANCH WAS OBSERVED BY ANY TIER. `use()` had no `catch` at all, so the
  // rejection case ended in an unhandled rejection and a silently un-busied button —
  // the person is looking at a medicine they believe they renamed. The DB and action
  // tiers cannot see this: it is entirely the client's handling of what came back.

  async function pressUse() {
    offer({ name: DOCUMENT_STRING, sourceName: null });
    await act(async () => {
      screen.getByTestId("imported-name-find").click();
    });
    await act(async () => {
      screen.getByTestId("imported-name-use-2418").click();
    });
  }

  it("tells the person when the action REJECTS", async () => {
    // Offline, a 500, a deploy mid-click: the promise rejects, it does not resolve
    // to an error shape.
    adoptAnswer = async () => {
      throw new Error("network down");
    };
    await pressUse();
    expect(
      toasted,
      "a rejected Server Action left the button un-busied and said NOTHING — the " +
        "person is told the rename did not happen, in the same words the action " +
        "uses for its own refusals"
    ).toEqual([["Couldn't rename that medication.", { tone: "error" }]]);
  });

  it("tells the person when the action REFUSES", async () => {
    // The `{ok:false}` shape — a stale offer, an RxNorm disagreement — whose message
    // is the action's own and must reach the screen unaltered.
    adoptAnswer = async () => ({
      ok: false,
      error: "Couldn't confirm that name with RxNorm just now. Try again.",
    });
    await pressUse();
    expect(toasted).toEqual([
      [
        "Couldn't confirm that name with RxNorm just now. Try again.",
        { tone: "error" },
      ],
    ]);
  });

  it("leaves the candidate list up so the press can be repeated", async () => {
    // Both failures. Clearing the list on a failure would strip the person of the
    // thing they were choosing from, with nothing renamed.
    adoptAnswer = async () => {
      throw new Error("network down");
    };
    await pressUse();
    expect(screen.getByTestId("imported-name-use-2418").textContent).toBe(
      "Use this name"
    );
  });

  it("says the rename happened when it did", async () => {
    // The control for the three above: the success message is distinguishable from
    // both failures, so a test asserting a failure toast cannot pass on silence.
    await pressUse();
    expect(toasted).toEqual([["Renamed to Cholecalciferol.", undefined]]);
  });
});
