// PURE TIER — THE WIDENED KNOWLEDGE-COMPLETENESS GUARD (issue #2086).
//
// `METRIC_KNOWLEDGE`'s totality is the strongest idea in the #1996 fix: a quantity
// cannot exist on the metric surface without declaring which knowledge system judges
// it, or arguing `none` with a reason. But its domain was `Record<BodyMetricSlug, …>`
// — ONE enum — so a judged quantity with no slug escaped the discipline entirely.
//
// The recorded escapee is VO₂ max: a curated canonical entry AND age/sex fitness norms,
// with nothing in the build able to notice whether either reached its readings. That is
// the pre-#1996 shape (knowledge existing, readings unjudged) recurring one layer out.
//
// So this test enumerates the domain from the REGISTRIES rather than from a hand-list —
// `BODY_METRIC_SLUGS`, `FITNESS_NORM_MARKERS` and `READING_IDENTITY_MAP` — and requires
// every judged quantity in it to resolve to a declaration. A norms marker added to the
// dataset with no declaration fails the build; a declaration naming a marker or a
// canonical entry that does not exist fails it too, so widening the GUARD can never
// widen the VOCABULARY (#482).
//
// All fixtures come from the committed datasets; no DB, no network.

import { describe, it, expect } from "vitest";
import {
  JUDGED_QUANTITY_IDENTITIES,
  METRIC_KNOWLEDGE,
  QUANTITY_KNOWLEDGE,
  quantityKnowledge,
} from "@/lib/metric-judgment";
import { readingIdentity } from "@/lib/reading-model";
import { READING_IDENTITY_MAP } from "@/lib/reading-identity-map";
import { canonicalBiomarkerForName } from "@/lib/datasets/canonical-biomarkers";
import {
  FITNESS_NORM_MARKERS,
  fitnessContext,
  hasFitnessNorms,
} from "@/lib/fitness-norms";
import { readingDetailHref } from "@/lib/hrefs";
import { BODY_METRIC_SLUGS } from "@/lib/trends-body-metrics";

describe("the domain is judged QUANTITIES, not one enum (#2086)", () => {
  it("every fitness-norm marker declares its knowledge source", () => {
    // The enumeration source is the norms dataset itself, so adding a marker there and
    // forgetting the declaration is a red test rather than a quantity nobody judges.
    const undeclared = FITNESS_NORM_MARKERS.filter(
      (marker) => quantityKnowledge(marker) == null
    );
    expect(
      undeclared,
      `norms markers with no knowledge declaration: ${undeclared.join(", ")} — ` +
        `add a QUANTITY_KNOWLEDGE entry naming the norms marker and the surface ` +
        `that renders it, or an argued "none"`
    ).toEqual([]);
  });

  it("every canonical name in the reading identity map resolves too", () => {
    // The other registry-derived half: a name the app streams or routes must have a
    // knowledge answer, whichever key its readings arrive under.
    for (const entry of READING_IDENTITY_MAP) {
      expect(
        quantityKnowledge(entry.canonical),
        `${entry.canonical} is registered in the identity map but declares no knowledge`
      ).not.toBeNull();
    }
  });

  it("every metric slug still declares one (the #1996 half, unchanged)", () => {
    const missing = BODY_METRIC_SLUGS.filter((s) => !METRIC_KNOWLEDGE[s]);
    expect(missing).toEqual([]);
  });
});

describe("the declarations name real knowledge — no invented vocabulary (#482)", () => {
  it("every fitness-norms declaration names a REAL norms marker", () => {
    for (const [name, k] of Object.entries(QUANTITY_KNOWLEDGE)) {
      if (k.source !== "fitness-norms") continue;
      expect(
        hasFitnessNorms(k.marker),
        `${name} claims norms marker "${k.marker}", which the dataset does not carry`
      ).toBe(true);
      expect(
        k.renderedBy.length,
        `${name} must name its surface`
      ).toBeGreaterThan(10);
    }
  });

  it("no STALE declaration — every declared marker is still in the dataset", () => {
    const known = new Set(FITNESS_NORM_MARKERS);
    const stale = Object.values(QUANTITY_KNOWLEDGE).flatMap((k) =>
      k.source === "fitness-norms" && !known.has(k.marker) ? [k.marker] : []
    );
    expect(
      stale,
      `retired markers still declared: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("a canonical-sourced declaration names a REAL curated entry", () => {
    for (const [name, k] of Object.entries(QUANTITY_KNOWLEDGE)) {
      if (k.source !== "canonical") continue;
      expect(
        canonicalBiomarkerForName(k.canonical),
        `${name} names "${k.canonical}", which is not in the canonical vocabulary`
      ).not.toBeNull();
    }
  });

  it("every argued 'none' carries a reason", () => {
    for (const [name, k] of Object.entries(QUANTITY_KNOWLEDGE)) {
      if (k.source !== "none") continue;
      expect(k.reason.length, `${name} has an empty reason`).toBeGreaterThan(
        20
      );
    }
  });

  it("one declaration per identity — the two halves never collide", () => {
    // A quantity declared BOTH through a metric slug and by name would be two answers
    // to one question, which is the disease the identity lookup exists to cure.
    const slugIdentities = new Set(
      Object.values(METRIC_KNOWLEDGE).flatMap((k) =>
        k.source === "canonical"
          ? [readingIdentity(k.canonical).toLowerCase()]
          : []
      )
    );
    const collisions = Object.keys(QUANTITY_KNOWLEDGE).filter((name) =>
      slugIdentities.has(readingIdentity(name).toLowerCase())
    );
    expect(collisions, `declared twice: ${collisions.join(", ")}`).toEqual([]);
    expect(new Set(JUDGED_QUANTITY_IDENTITIES).size).toBe(
      JUDGED_QUANTITY_IDENTITIES.length
    );
  });
});

describe("VO₂ max — the acceptance case (#2086, owner ruling 2026-08-05)", () => {
  const knowledge = quantityKnowledge("VO2 Max");

  it("is a declared judged quantity, judged by its age/sex norms", () => {
    expect(knowledge).toMatchObject({
      source: "fitness-norms",
      marker: "VO2 Max",
    });
  });

  it("names a surface, and that surface is the one the reading actually routes to", () => {
    // The declaration is only worth anything if the named surface is where a VO₂ max
    // reading really lands. `readingDetailHref` is the ONE routing rule (#1932), so
    // asking it is asking the app, not restating the registry.
    expect(knowledge?.source).toBe("fitness-norms");
    expect(readingDetailHref("VO2 Max")).toBe(
      "/results/readings/view?name=VO2%20Max"
    );
  });

  it("its norms genuinely reach a reading — knowledge that resolves, not knowledge that exists", () => {
    // The #2086 defect was knowledge existing beside readings nothing applied it to.
    // A real value for a real adult subject must produce a percentile.
    const ctx = fitnessContext("VO2 Max", 42, "male", 55);
    expect(ctx).not.toBeNull();
    expect(ctx?.percentile.percentile).toBeGreaterThan(0);
    expect(ctx?.fitnessAge).not.toBeNull();
  });

  it("resolves by #482 identity, so an aliased spelling answers the same", () => {
    expect(quantityKnowledge(readingIdentity("VO2 Max"))).toBe(knowledge);
  });
});
