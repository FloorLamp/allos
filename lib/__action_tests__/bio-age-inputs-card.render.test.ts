// SERVER-COMPONENT RENDER TIER — what the bio-age inputs card actually PUTS ON
// SCREEN (#3050, holding #2367's split).
//
// Every other guard on this card tests something one step away from the reader: the
// copy layer's sentences (pure), the gather's shapes (DB), the source's vocabulary (a
// scan). None of them can answer "does the card show an import button in the state
// where importing is the whole answer", and a scan over spellings cannot answer "can
// this card render the number" — a review defeated exactly that scan with ordinary
// destructuring while every tier stayed green.
//
// So this file renders the component. It is an async server component, so it is
// awaited directly and its returned React tree is walked — no DOM, no Next runtime,
// no react-dom. It lives in the ACTION tier because that is where `requireSession` is
// mocked; the database underneath is the real throwaway one, so each state below is a
// real profile with real rows.
//
// SYNTHETIC ONLY: invented profiles, invented values. No PHI.

import { describe, expect, it, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { seedActor } from "./harness";
import { getBioAgeReadings } from "@/lib/queries";
import { PHENOAGE_INPUT_NAMES } from "@/lib/bio-age";
import { setProfileBirthdate } from "@/lib/settings";
import BioAgeInputsCard from "@/app/(app)/results/BioAgeInputsCard";

const CRP = "High-Sensitivity C-Reactive Protein (hs-CRP)";

const NINE: [string, string, number][] = [
  ["Albumin", "g/dL", 4.4],
  ["Creatinine", "mg/dL", 0.9],
  ["Glucose", "mg/dL", 90],
  ["Lymphocytes", "%", 32],
  ["Mean Corpuscular Volume (MCV)", "fL", 89],
  ["Red Cell Distribution Width (RDW)", "%", 13],
  ["Alkaline Phosphatase", "U/L", 62],
  ["White Blood Cell Count", "10^3/uL", 5.5],
  [CRP, "mg/L", 0.4],
];

function draw(profileId: number, date: string, omit: string[] = []): void {
  for (const [canonical, unit, value] of NINE) {
    if (omit.includes(canonical)) continue;
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
    ).run(profileId, date, canonical, String(value), unit, canonical, value);
  }
}

// A rendered card, flattened to the two things an assertion here needs: every string
// the reader sees, and every link. React elements are plain objects, so the walk is
// the whole renderer — a component child (next/link) is not invoked, which is why its
// own props carry the href.
interface Rendered {
  text: string;
  links: { href: string; label: string }[];
}

function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? textOf(props.children) : "";
}

function collectLinks(node: unknown, into: Rendered["links"]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectLinks(child, into);
    return;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return;
  if (typeof props.href === "string")
    into.push({ href: props.href, label: textOf(props.children).trim() });
  collectLinks(props.children, into);
}

async function renderCard(): Promise<Rendered> {
  const tree = await BioAgeInputsCard();
  const links: Rendered["links"] = [];
  collectLinks(tree, links);
  return { text: textOf(tree).replace(/\s+/g, " ").trim(), links };
}

// Seed one profile per state and act as it, so each render is a real gather.
async function cardFor(
  name: string,
  seed: (profileId: number) => void
): Promise<Rendered> {
  const { profile } = seedActor({ profileName: name });
  setProfileBirthdate(profile.id, "1980-01-01");
  seed(profile.id);
  return renderCard();
}

const IMPORT_LABS = "Import labs";
const hasImportCta = (r: Rendered) =>
  r.links.some((l) => l.label === IMPORT_LABS);

let computed: Rendered;
let stale: Rendered;
let neverTogether: Rendered;
let partial: Rendered;
let computedBioAge: number;

beforeAll(async () => {
  computed = await cardFor("card_computed", (id) => {
    draw(id, "2026-06-03");
    computedBioAge = getBioAgeReadings(id).draws[0].bioAge;
  });
  stale = await cardFor("card_stale", (id) => {
    draw(id, "2026-06-03");
    draw(id, "2026-07-12", [CRP]);
  });
  neverTogether = await cardFor("card_never_together", (id) => {
    draw(
      id,
      "2020-02-02",
      PHENOAGE_INPUT_NAMES.filter((n) => n !== "Albumin")
    );
    draw(id, "2026-06-03", ["Albumin"]);
  });
  partial = await cardFor("card_partial", (id) => {
    draw(id, "2026-06-03", [CRP, "Albumin"]);
  });
});

describe("the import CTA follows the STATUS, not the tick count (#3050)", () => {
  it("offers the import in every state where importing is the answer", () => {
    // Keyed on `!completeness.complete`, the button vanished in the two states that
    // most need it: nine analytes ticked but never on one draw, and a re-draw that
    // missed by one. Both leave the reader a card with nothing to act on.
    expect(hasImportCta(neverTogether)).toBe(true);
    expect(hasImportCta(stale)).toBe(true);
    expect(hasImportCta(partial)).toBe(true);
  });

  it("withdraws it once a current draw computes", () => {
    expect(hasImportCta(computed)).toBe(false);
  });

  it("keeps the door to the hero in every state", () => {
    for (const r of [computed, stale, neverTogether, partial])
      expect(r.links.map((l) => l.href)).toContain("/longevity#bio-age");
  });
});

describe("the card says which draw, and never the number (#2367)", () => {
  it("names the draw the linked result is computed from", () => {
    expect(computed.text).toContain(
      "All 9 inputs present · computed from your Jun 3, 2026 draw."
    );
  });

  it("names the gap and the still-live draw after a partial re-draw", () => {
    expect(stale.text).toContain(
      `Your Jul 12, 2026 panel is missing ${CRP} — your biological age is still from Jun 3, 2026.`
    );
  });

  it("does not claim a result when no draw carries all nine", () => {
    expect(neverTogether.text).toContain(
      "All 9 inputs present, but not from one draw — the model needs them together."
    );
  });

  it("puts the ESTIMATE on screen in no state", () => {
    // The strongest form of #2367's rule available: the very number the Longevity
    // hero renders for this profile, asserted absent from this card's text. It holds
    // whatever anyone renames — and `getBioAgeInputCatalog` means there is nothing in
    // scope here to render it from.
    expect(computedBioAge).toBeGreaterThan(0);
    for (const r of [computed, stale, neverTogether, partial]) {
      expect(r.text).not.toContain(String(computedBioAge));
      expect(r.text).not.toContain(String(Math.trunc(computedBioAge)));
      expect(r.text).not.toMatch(/calendar age/i);
      expect(r.text).not.toMatch(/years (younger|older)/i);
      expect(r.text).not.toMatch(/per year/i);
    }
  });

  it("still renders the catalog it owns: nine analytes, and the model's caveat", () => {
    for (const name of PHENOAGE_INPUT_NAMES)
      expect(computed.text).toContain(name);
    expect(computed.text).toContain(
      "needs all nine of these analytes from one draw"
    );
  });
});
