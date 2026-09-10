import { describe, expect, it } from "vitest";
import {
  uncuratedAnalyte,
  uncuratedAnalytes,
  uncuratedAnalytesDataset,
  type UncuratedAnalyte,
} from "@/lib/datasets/uncurated-analytes";
import { DATASETS } from "@/lib/datasets/registry";
import { normalizeCanonicalKey } from "@/lib/canonical-name";

// Anti-drift pins for the deliberately-uncurated registry after it moved out of
// lib/canonical-name.ts into lib/datasets/data/uncurated-analytes.json (#5175). The
// relocation's correctness was proved by a differential: every name the registry can
// answer for — every DEXA region, compartment, scan-level row and declared key, in the
// spellings a caller can produce, plus the near-misses it must refuse — asked of the
// OLD module and of this loader, answers compared including declaration identity. What
// remains to pin permanently is what that one-shot diff can no longer watch:
//
//   - the VALUE DOMAINS the in-code literals used to typecheck (see below);
//   - the discriminant's invariant: `instead` exactly when `covered-elsewhere`;
//   - that a declaration is ONE object shared by every spelling it covers (surfaces and
//     lib/__tests__/canonical-name.test.ts compare declarations by identity to say
//     "same decision");
//   - that the generator-fed entries are reachable at all — an entry with no `names`
//     that the DEXA product never mints would be a decision nothing reads.
//
// What each analyte's decision IS and why stays in canonical-name.test.ts, which owns
// the registry's MEANING (the #2319/#2322/#2643/#2679/#2765 cases). This file owns the
// dataset's SHAPE. Don't add a third. Pure — no DB, no network.

// ── The legal value sets ──────────────────────────────────────────────────────
// `kind` is the only field that was a UNION in the old literals, and it has no runtime
// witness to derive a set from — so it is a `satisfies`-checked record: `satisfies`
// fails on a MISSING member and the excess-property check fails on an INVENTED one,
// which pins this literal to the union in both directions at compile time. That is the
// nearest thing to a witness the union has, and it is what keeps the pin below honest
// if a third kind is ever added.
const KINDS = {
  "covered-elsewhere": true,
  "out-of-scope": true,
} satisfies Record<UncuratedAnalyte["kind"], true>;

const KIND_SET = new Set<string>(Object.keys(KINDS));

const ENTRIES = uncuratedAnalytesDataset.entries;

describe("uncurated-analytes.json dataset", () => {
  it("is the registered `uncurated-analytes` envelope, identified by decision id", () => {
    expect(uncuratedAnalytesDataset.id).toBe("uncurated-analytes");
    expect(uncuratedAnalytesDataset.identity.keys).toEqual(["id"]);
    expect(uncuratedAnalytesDataset.citation.length).toBeGreaterThan(0);
    expect(DATASETS.map((d) => d.dataset.id)).toContain("uncurated-analytes");
  });

  // ── Value domains ───────────────────────────────────────────────────────────
  // The guarantee the relocation traded away. The in-code literals were fully
  // typechecked, so `kind: "out-of-scoop"` was a COMPILE error and a `covered-elsewhere`
  // without an `instead` did not compile at all. A JSON entry gets its typing from
  // `loadDataset<UncuratedAnalyteEntry, …>`'s type PARAMETER, which is erased:
  // loadDataset validates the envelope and the identity keys, and the framework harness
  // checks citations, identity, refusal and key collisions — none of them asks whether a
  // value belongs to its union. These are that check, at the boundary, so a bad value
  // fails HERE naming the entry rather than resolving to a declaration nothing can read.
  it("gives every entry a real kind, a reason, and an `instead` exactly when covered-elsewhere", () => {
    for (const e of ENTRIES) {
      expect(KIND_SET.has(e.kind), `${e.id}: kind "${e.kind}"`).toBe(true);
      // The MetricKnowledge `{ source: "none"; reason }` rule, at the DATA boundary:
      // canonical-name.test.ts pins it on the resolved declarations, this pins it on
      // the rows, so an entry the generator never mints cannot ship blank either.
      expect(e.reason.trim().length, `${e.id}: empty reason`).toBeGreaterThan(0);
      if (e.kind === "covered-elsewhere") {
        // `instead` is what a surface LINKS to; the old union made it non-optional.
        expect(
          typeof e.instead === "string" && e.instead.trim() !== "",
          `${e.id}: covered-elsewhere with no \`instead\``
        ).toBe(true);
      } else {
        // An `instead` on an out-of-scope row is a target the shape says does not
        // exist — the loader drops it, so it would be a promise nothing keeps.
        expect("instead" in e, `${e.id}: out-of-scope carries an \`instead\``).toBe(
          false
        );
      }
    }
  });

  it("gives every entry a unique slug id and no colliding declared name", () => {
    const ids = ENTRIES.map((e) => e.id);
    expect(new Set(ids).size, `duplicate id in ${ids.join(", ")}`).toBe(
      ids.length
    );
    for (const id of ids) expect(id, `${id}: not a slug`).toMatch(/^[a-z0-9-]+$/);
    // Two entries declaring one normalized key would resolve by whichever the map
    // wrote last — the registry's own collision, invisible to the framework harness
    // because the harness keys on `id`.
    const seen = new Map<string, string>();
    for (const e of ENTRIES) {
      for (const name of e.names ?? []) {
        expect(name.trim(), `${e.id}: blank declared name`).not.toBe("");
        const key = normalizeCanonicalKey(name);
        const prev = seen.get(key);
        expect(prev, `${e.id}: "${name}" collides with ${prev}`).toBeUndefined();
        seen.set(key, e.id);
      }
    }
  });

  it("shares ONE declaration object across every spelling an entry covers", () => {
    for (const e of ENTRIES) {
      const names = e.names ?? [];
      if (names.length < 2) continue;
      const declarations = names.map((n) => uncuratedAnalyte(n));
      for (const [i, d] of declarations.entries()) {
        expect(d, `${e.id}: "${names[i]}" resolves to nothing`).not.toBeNull();
        // Identity, not equality: "same decision" is what the shared object MEANS.
        expect(d, `${e.id}: "${names[i]}" is a different object`).toBe(
          declarations[0]
        );
      }
    }
  });

  it("mints a reachable row for every generator-fed entry (no `names`)", () => {
    // An entry the DEXA product never emits is a decision nothing can read — the
    // failure mode of moving the generator's inputs into data.
    const reached = new Set(uncuratedAnalytes().map(([, d]) => d));
    const generated = ENTRIES.filter((e) => (e.names ?? []).length === 0);
    expect(generated.map((e) => e.id)).toEqual([
      "dexa-decomposition",
      "dexa-site-bmd",
    ]);
    for (const e of generated) {
      const hit = uncuratedAnalytes().find(([, d]) => d.reason === e.reason);
      expect(hit, `${e.id}: generator mints no row for it`).toBeDefined();
      expect(reached.has(hit![1])).toBe(true);
    }
  });

  // ── The generator's inputs ──────────────────────────────────────────────────
  // The JSON declares the regions; the loader declares the product. These pin the
  // declarations, so a list emptied or a region duplicated fails naming the list
  // rather than quietly minting fewer rows.
  it("declares every DEXA list non-empty, duplicate-free, and without the whole-body total", () => {
    const dexa = uncuratedAnalytesDataset.meta!.dexa;
    for (const [list, values] of Object.entries(dexa)) {
      expect(values.length, `${list}: empty`).toBeGreaterThan(0);
      expect(new Set(values).size, `${list}: duplicate member`).toBe(
        values.length
      );
      for (const v of values)
        expect(v.trim(), `${list}: blank member`).not.toBe("");
    }
    // "Total" is absent from the three REGION lists on purpose: the whole-body number
    // is the CURATED entry ("Body Fat Percentage", "Bone Mineral Density T-Score"), and
    // the scan-level rows that are whole-body are listed by name instead. A "Total"
    // that crept into a region list would mint a row declaring a curated analyte
    // uncurated — the contradiction canonical-name.test.ts's completeness guard exists
    // to catch, pinned here at the input that would cause it.
    for (const list of ["fatRegions", "boneRegions", "massRegions"] as const) {
      expect(dexa[list], `${list}: carries the whole-body total`).not.toContain(
        "Total"
      );
    }
  });

  it("splits the DEXA product's two declarations by row, density from content", () => {
    const dexa = uncuratedAnalytesDataset.meta!.dexa;
    const density = uncuratedAnalyte(
      `Bone Mineral Density, ${dexa.boneRegions[0]}`
    );
    const content = uncuratedAnalyte(
      `Bone Mineral Content, ${dexa.boneRegions[0]}`
    );
    expect(density).not.toBeNull();
    expect(content).not.toBeNull();
    // #2765: one grid, two sentences. Same object across every site, different
    // objects across the two row kinds.
    expect(density).not.toBe(content);
    for (const region of dexa.boneRegions) {
      expect(
        uncuratedAnalyte(`Bone Mineral Density, ${region}`),
        `${region}: density`
      ).toBe(density);
      expect(
        uncuratedAnalyte(`Bone Mineral Content, ${region}`),
        `${region}: content`
      ).toBe(content);
    }
    for (const region of dexa.fatRegions)
      expect(
        uncuratedAnalyte(`Body Fat Percentage, ${region}`),
        `${region}: fat`
      ).toBe(content);
    for (const region of dexa.massRegions)
      for (const compartment of dexa.massCompartments) {
        const name = `${region} ${compartment} Mass`;
        expect(uncuratedAnalyte(name), name).toBe(content);
        // Reports print the unit inside the name as often as not.
        expect(uncuratedAnalyte(`${name} (g)`), `${name} (g)`).toBe(content);
      }
    for (const name of dexa.scanLevel)
      expect(uncuratedAnalyte(name), name).toBe(content);
  });
});
