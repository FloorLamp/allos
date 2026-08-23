// SERVER-COMPONENT RENDER TIER — does the import review page actually PUT THE OFFER
// CARD ON SCREEN (#3480)?
//
// WHY THIS FILE EXISTS. Every other guard on this feature tests something one step
// away from the reader: the predicate over strings (pure), the read and the write
// over rows (DB), the RxNorm re-check through the action. None of them can answer
// "does the page render the card", and the measurement that made this file necessary
// is that deleting `<ImportedNamesCard />` from app/(app)/import/[id]/page.tsx left
// the entire pure tier green AND `eslint` at exit 0 — the orphaned import and the
// orphaned const pass, because there is no `noUnusedLocals` here. A regression would
// have been a silent no-op: the card never appears, the feature is gone, every gate
// green.
//
// It also pins the TAB GATE. The offer rows are built only on the Medications tab, so
// a page rendered on another tab must not carry the card — and the pair that decides
// it (`MEDICATIONS_TAB_KEY` in lib/import-browser.ts, on both ends) is what makes the
// two literals move together.
//
// The page is an async server component, so it is awaited directly and the React tree
// it returns is walked — no DOM, no react-dom, no Next runtime. Client components
// inside it are never invoked; they are plain element objects carrying their props,
// which is exactly what an assertion about "is the card there, with these rows" needs.
//
// All fixtures synthetic. The medication string is a product label, not anybody's data.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { seedActor } from "./harness";
import ImportDetailPage from "@/app/(app)/import/[id]/page";
import ImportedNamesCard from "@/components/import/ImportedNamesCard";

const PORTAL_NAME = "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)";
const PLAIN_NAME = "Lisinopril";

// Every element in a rendered tree, reduced to the two things an assertion here
// needs: what it IS (a tag name, or the component function's name) and the props it
// was handed. React elements are plain objects, so this walk is the whole renderer
// for the purposes of this question — a component child is not invoked, which is
// exactly why its own props are what carry the answer.
interface Node {
  name: string;
  props: Record<string, unknown>;
}

function nameOf(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function")
    return (type as { name?: string }).name || "anonymous";
  return "";
}

function collect(node: unknown, into: Node[]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, into);
    return;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return;
  const name = nameOf(el.type);
  if (name) into.push({ name, props: el.props });
  collect(el.props.children, into);
}

function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? textOf(props.children) : "";
}

let profileId = 0;
let documentId = 0;

async function renderTab(tab?: string): Promise<Node[]> {
  const tree = await ImportDetailPage({
    params: Promise.resolve({ id: String(documentId) }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
  const found: Node[] = [];
  collect(tree, found);
  return found;
}

// The cards the page rendered, by component name.
function cards(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.name === "ImportedNamesCard");
}

function importedMedication(name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, source, document_id)
         VALUES (?, ?, 'medication', 'extracted', ?)`
      )
      .run(profileId, name, documentId).lastInsertRowid
  );
}

let medications: Node[];
let visits: Node[];

beforeAll(async () => {
  const { profile } = seedActor({ profileName: "import card render" });
  profileId = profile.id;
  documentId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type,
            extracted_count)
         VALUES (?, 'meds.ccd', '', 'done', 'ccd', 2)`
      )
      .run(profileId).lastInsertRowid
  );
  importedMedication(PORTAL_NAME);
  importedMedication(PLAIN_NAME);
  // A second produced type, so there is another tab to land on and the tab gate has
  // something to be gated against.
  db.prepare(
    `INSERT INTO encounters (profile_id, document_id, date, type)
     VALUES (?, ?, '2026-07-01', 'Office visit')`
  ).run(profileId, documentId);

  medications = await renderTab("medications");
  visits = await renderTab("visits");
});

describe("the import review page renders the imported-name card", () => {
  it("puts the card on the Medications tab", () => {
    expect(cards(medications)).toHaveLength(1);
  });

  it("hands it the document-string row and only that row", () => {
    // "Lisinopril" is imported too and reads fine, so a card handed every imported
    // medication would be a nag rather than a review.
    const rows = cards(medications)[0].props.rows as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([PORTAL_NAME]);
  });

  it("hands it the document it was rendered on", () => {
    // The action refuses a row that did not come from the document named in the
    // payload, so a card built with the wrong document id would be a dead button.
    expect(cards(medications)[0].props.documentId).toBe(documentId);
  });

  it("does not render the card on another tab", () => {
    expect(cards(visits)).toHaveLength(0);
  });
});

describe("the card the page renders", () => {
  // The page hands the card its rows; this is what the card then puts on screen. It
  // is a plain synchronous server component, so calling it IS rendering it — the
  // client offer rows inside stay uninvoked elements carrying their props, which is
  // all an assertion about "one offer row, for this row, on this document" needs.
  const rendered = () => {
    const found: Node[] = [];
    collect(
      ImportedNamesCard({
        documentId: 41,
        rows: [{ id: 7, name: PORTAL_NAME, source_name: null }],
      }),
      found
    );
    return found;
  };

  it("carries the card marker and one offer per row", () => {
    const nodes = rendered();
    expect(
      nodes.some((n) => n.props["data-testid"] === "imported-names-card")
    ).toBe(true);
    const offers = nodes.filter((n) => n.name === "ImportedNameOffer");
    expect(offers).toHaveLength(1);
    expect(offers[0].props).toMatchObject({
      itemId: 7,
      documentId: 41,
      name: PORTAL_NAME,
    });
  });

  it("does not call the rows medications in its lead", () => {
    // An imported medication can be re-saved as a Supplement and still be offered
    // (the boundary follows provenance, not kind), so a lead that says "these
    // medications" would be wrong on screen for exactly those rows.
    const text = textOf(
      ImportedNamesCard({
        documentId: 41,
        rows: [{ id: 7, name: PORTAL_NAME, source_name: null }],
      })
    );
    expect(text).toContain("the wording the document used");
    expect(text).not.toContain("These medications");
  });
});
