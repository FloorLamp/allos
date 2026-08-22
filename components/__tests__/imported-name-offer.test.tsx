import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/app/(app)/nutrition/intake-actions", () => ({
  lookupRxcui: vi.fn(async () => [
    // One usable concept and one that is itself a document string, so the
    // `isCleanerName` filter has something to do.
    { rxcui: "2418", name: "Cholecalciferol" },
    { rxcui: "9999", name: "VITAMIN D3 1000 UNIT CAP" },
  ]),
}));

const adopt = vi.fn(async () => ({ ok: true }) as const);
vi.mock("@/app/(app)/import/name-actions", () => ({
  adoptImportedMedicationName: (fd: FormData) => adopt(fd),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/components/Toast", () => ({ useToast: () => vi.fn() }));

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
    expect(adopt).toHaveBeenCalledTimes(1);
    const fd = adopt.mock.calls[0][0] as unknown as FormData;
    expect(Object.fromEntries(fd.entries())).toEqual({
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
