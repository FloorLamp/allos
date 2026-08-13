import { describe, expect, it } from "vitest";
import {
  diagnosisList,
  groupDiagnosisChips,
  type DiagnosisChipGroup,
} from "../diagnosis-chips";

// #2589 half 2. The grouping is PRESENTATION: it prints a shared stem once so a
// long diagnosis listed twice with a suffix stops costing four wrapped lines on a
// phone card. The invariants that matter are the ones the two withdrawn string
// rules broke — nothing may be dropped, renamed or reordered — plus the new one
// this layer owes: every original string must be recoverable from what it emits.

// The names as the reporter's CCD stored them.
const Z_CODE =
  "Encounter of male for testing for genetic disease carrier status for procreative management";

// Every original name, in order, as the groups carry them.
function namesOut(groups: DiagnosisChipGroup[]): string[] {
  return groups.flatMap((g) =>
    g.kind === "single" ? [g.name] : g.members.map((m) => m.name)
  );
}

describe("diagnosisList", () => {
  it("splits the joined summary and drops blanks", () => {
    expect(diagnosisList("Acute bronchitis; Anemia")).toEqual([
      "Acute bronchitis",
      "Anemia",
    ]);
    expect(diagnosisList(" Anemia ;; ")).toEqual(["Anemia"]);
    expect(diagnosisList(null)).toEqual([]);
    expect(diagnosisList("")).toEqual([]);
  });
});

describe("groupDiagnosisChips — the reported pair", () => {
  const names = [Z_CODE, `${Z_CODE} - Primary`];
  const groups = groupDiagnosisChips(names);

  it("prints the shared stem once", () => {
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind).toBe("shared");
    if (g.kind !== "shared") return;
    expect(g.stem).toBe(Z_CODE);
    expect(g.members.map((m) => m.tail)).toEqual(["", " - Primary"]);
  });

  it("keeps both names whole and recoverable", () => {
    expect(namesOut(groups)).toEqual(names);
    const g = groups[0];
    if (g.kind !== "shared") return;
    for (const m of g.members) {
      // stem + tail is the original EXACTLY — no join character, no dropped
      // separator. This identity is what makes printing the stem once a
      // factoring rather than a truncation.
      expect(`${g.stem}${m.tail}`).toBe(m.name);
    }
  });
});

describe("groupDiagnosisChips — what it refuses to touch", () => {
  it("leaves the short clinical pair as two plain chips", () => {
    // The pair that refuted attempt 1 — left alone because the names are SHORT,
    // which is all the length gate knows. It is not a clinical discriminator: the
    // long-etiology case below groups, deliberately.
    const names = ["Hyperparathyroidism", "Hyperparathyroidism - Secondary"];
    expect(groupDiagnosisChips(names)).toEqual([
      { kind: "single", name: "Hyperparathyroidism" },
      { kind: "single", name: "Hyperparathyroidism - Secondary" },
    ]);
  });

  it("leaves the renal problem list exactly as stored", () => {
    // The list that refuted attempt 2, which deleted the secondary
    // hyperparathyroidism out of it at boot.
    const names = [
      "Chronic kidney disease stage 5",
      "Hyperparathyroidism",
      "Hyperparathyroidism - Secondary",
      "Anemia",
    ];
    const groups = groupDiagnosisChips(names);
    expect(namesOut(groups)).toEqual(names);
    expect(groups.every((g) => g.kind === "single")).toBe(true);
  });

  it("never reorders, and only groups a consecutive run", () => {
    const names = [Z_CODE, "Essential hypertension", `${Z_CODE} - Primary`];
    const groups = groupDiagnosisChips(names);
    // The twin is three entries away; pulling it up to its match would be a
    // reordering of a clinician-ordered list.
    expect(namesOut(groups)).toEqual(names);
    expect(groups.map((g) => g.kind)).toEqual(["single", "single", "single"]);
  });

  it("does not split a shared stem mid-word", () => {
    const a = `${Z_CODE} in a subject aged 1`;
    const b = `${Z_CODE} in a subject aged 12`;
    const groups = groupDiagnosisChips([a, b]);
    const g = groups[0];
    expect(g.kind).toBe("shared");
    if (g.kind !== "shared") return;
    // "…aged 1" is a raw common prefix, but 1 and 12 are one token, so the stem
    // stops at the last boundary both names agree on.
    expect(g.stem.endsWith("aged")).toBe(true);
    expect(g.members.map((m) => m.tail)).toEqual([" 1", " 12"]);
  });

  it("refuses a group whose tails outweigh the stem", () => {
    const stem = "Malignant neoplasm of unspecified site of ";
    const names = [
      `${stem}the left upper outer quadrant, with regional nodal spread`,
      `${stem}the right lower inner quadrant, with distant metastasis`,
    ];
    // The shared run is long, but so is everything after it; factoring saves
    // nothing and reads worse than the two plain names.
    expect(groupDiagnosisChips(names).map((g) => g.kind)).toEqual([
      "single",
      "single",
    ]);
  });

  it("is a no-op on a single entry and on an empty list", () => {
    expect(groupDiagnosisChips([Z_CODE])).toEqual([
      { kind: "single", name: Z_CODE },
    ]);
    expect(groupDiagnosisChips([])).toEqual([]);
  });
});

// The separator run between the stem and a tail is the character class this
// nearly lost: an earlier version printed `slice(0, k)` MINUS its trailing
// separators as the stem while the tail started at `k`, so " - " was rendered
// nowhere and "…of breast" sat beside a bare "Left". One example could not catch
// it (the "- Primary" case survives, because there the dash lands inside the
// tail), so this is checked as a PROPERTY over generated pairs, and it is what
// pins STEM_TRAILING: delete the trim and the stem ends with a dangling
// separator; move the trim without moving the tail's start and reconstruction
// breaks.
describe("groupDiagnosisChips — reconstruction is exact (property)", () => {
  const STEMS = [
    "Malignant neoplasm of the upper outer quadrant of breast",
    "Amyloidosis of the kidney with nephrotic syndrome",
    "Encounter for antineoplastic chemotherapy and immunotherapy",
    "Adrenal cortical insufficiency with electrolyte disturbance",
  ];
  const SEPARATORS = ["", " ", " - ", " – ", " — ", ", ", "; ", ": ", "/", "-"];
  const TAILS = ["Left", "Right", "Primary", "Secondary", "1", "12"];

  const pairs: [string, string][] = [];
  for (const stem of STEMS) {
    for (const sep of SEPARATORS) {
      for (let i = 0; i < TAILS.length; i++) {
        const j = (i + 1) % TAILS.length;
        pairs.push([`${stem}${sep}${TAILS[i]}`, `${stem}${sep}${TAILS[j]}`]);
      }
    }
  }

  it("emits every name back, in order, with stem + tail === name", () => {
    for (const pair of pairs) {
      const groups = groupDiagnosisChips(pair);
      expect(namesOut(groups), pair.join(" | ")).toEqual(pair);
      for (const g of groups) {
        if (g.kind !== "shared") continue;
        for (const m of g.members) {
          expect(`${g.stem}${m.tail}`, `${g.stem} + ${m.tail}`).toBe(m.name);
        }
      }
    }
  });

  it("never prints a stem that ends in a separator", () => {
    for (const pair of pairs) {
      for (const g of groupDiagnosisChips(pair)) {
        if (g.kind !== "shared") continue;
        expect(/[\s\-–—,;:/]$/.test(g.stem), g.stem).toBe(false);
      }
    }
  });

  it("carries the separator on the tail rather than deleting it", () => {
    const names = [
      "Malignant neoplasm of the upper outer quadrant of breast - Left",
      "Malignant neoplasm of the upper outer quadrant of breast - Right",
    ];
    const g = groupDiagnosisChips(names)[0];
    expect(g.kind).toBe("shared");
    if (g.kind !== "shared") return;
    expect(g.stem).toBe(
      "Malignant neoplasm of the upper outer quadrant of breast"
    );
    expect(g.members.map((m) => m.tail)).toEqual([" - Left", " - Right"]);
  });
});

describe("groupDiagnosisChips — general long-diagnosis compaction", () => {
  it("groups a long ETIOLOGY pair too — the length gate is about wrapping, not meaning", () => {
    // Stated plainly because the PR body and module header now say so: real
    // etiology pairs clear 40 characters and DO group. That is accepted here and
    // nowhere else — both names print in full, in order, nothing is stored or
    // deleted, and the renderer keeps them distinct from a source-stated rank.
    const stem = "Amyloidosis of the kidney with nephrotic syndrome";
    const names = [`${stem} - Primary`, `${stem} - Secondary`];
    const g = groupDiagnosisChips(names)[0];
    expect(g.kind).toBe("shared");
    if (g.kind !== "shared") return;
    expect(g.members.map((m) => m.name)).toEqual(names);
    expect(g.members.map((m) => `${g.stem}${m.tail}`)).toEqual(names);
  });

  it("groups three consecutive variants of one long stem", () => {
    const stem =
      "Encounter for antineoplastic chemotherapy and immunotherapy admission";
    const names = [`${stem} - Primary`, `${stem} - Secondary`, `${stem}`];
    const groups = groupDiagnosisChips(names);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    if (g.kind !== "shared") throw new Error("expected a shared group");
    expect(g.stem).toBe(stem);
    // Both qualifiers survive as themselves — the compaction never decides that
    // "- Secondary" was a rank word, which is the judgment no string can make.
    expect(g.members.map((m) => m.tail)).toEqual([
      " - Primary",
      " - Secondary",
      "",
    ]);
    expect(namesOut(groups)).toEqual(names);
  });

  it("groups unrelated-but-long shared stems too — it is not a duplicate rule", () => {
    const stem = "Type 2 diabetes mellitus with diabetic chronic kidney";
    const names = [`${stem} disease`, `${stem} failure`];
    const g = groupDiagnosisChips(names)[0];
    expect(g.kind).toBe("shared");
    if (g.kind !== "shared") return;
    expect(g.members.map((m) => m.tail)).toEqual([" disease", " failure"]);
  });
});
