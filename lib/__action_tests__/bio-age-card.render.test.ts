// SERVER-COMPONENT RENDER TIER — what the Results bio-age card actually PUTS ON
// SCREEN (#3050, #5556).
//
// Every other guard on this card tests something one step away from the reader: the
// copy layer's sentences (pure) and the gather's shapes (DB). Neither can answer
// "does the card show an import button in the state where importing is the whole
// answer", or "does it show the number exactly when a complete draw exists".
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
import {
  bioAgeDelta,
  bioAgeDeltaPhrase,
  PHENOAGE_INPUT_NAMES,
} from "@/lib/bio-age";
import { setProfileBirthdate } from "@/lib/settings";
import BioAgeCard from "@/app/(app)/results/BioAgeCard";

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
  const tree = await BioAgeCard();
  const links: Rendered["links"] = [];
  collectLinks(tree, links);
  return { text: textOf(tree).replace(/\s+/g, " ").trim(), links };
}

// Seed one profile per state and act as it, so each render is a real gather.
async function cardFor(
  name: string,
  seed: (profileId: number) => void,
  birthdate = "1980-01-01"
): Promise<Rendered> {
  const { profile } = seedActor({ profileName: name });
  setProfileBirthdate(profile.id, birthdate);
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
let computedChronoAge: number;
let minorTree: unknown;

beforeAll(async () => {
  computed = await cardFor("card_computed", (id) => {
    draw(id, "2026-06-03");
    const [first] = getBioAgeReadings(id).draws;
    computedBioAge = first.bioAge;
    computedChronoAge = first.chronoAge!;
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
  const { profile: minor } = seedActor({ profileName: "card_minor" });
  setProfileBirthdate(minor.id, "2012-01-01");
  draw(minor.id, "2026-06-03");
  minorTree = await BioAgeCard();
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
});

describe("the card says which draw the number is from (#3050, #5556)", () => {
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

  it("shows the estimate whenever a complete draw exists, and only then", () => {
    const delta = bioAgeDelta(computedBioAge, computedChronoAge);
    for (const r of [computed, stale]) {
      expect(r.text).toContain(`${delta.bioAge} years Estimate`);
      expect(r.text).toContain(bioAgeDeltaPhrase(delta));
    }
    for (const r of [neverTogether, partial])
      expect(r.text).not.toMatch(/calendar age/i);
  });

  it("shows nothing to a minor, even with a complete draw", () => {
    expect(minorTree).toBeNull();
  });

  it("still renders the checklist without a result: nine analytes, and the model's caveat", () => {
    for (const name of PHENOAGE_INPUT_NAMES)
      expect(partial.text).toContain(name);
    expect(partial.text).toContain(
      "needs all nine of these analytes from one draw"
    );
  });
});
