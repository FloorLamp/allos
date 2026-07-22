// The dedupeKey → display resolver behind Upcoming's aggregated "Snoozed &
// dismissed" section (issue #1151), plus its PREFIX-COVERAGE GUARD: every
// namespace in the rule-finding registry (and the care/suggestion namespaces)
// must have a display mapping, so a NEW finding engine can't ship a key that
// renders un-displayable in the central view (the #448/#203 registry-guard
// pattern applied to labels).

import { describe, it, expect } from "vitest";
import {
  resolveSuppressedKeyDisplay,
  orphanSuppressionDisplay,
  hasExplicitRegistryLabel,
  domainForRichKey,
  ORPHAN_SUPPRESSION_LABEL,
  SUPPRESSION_DISPLAY_PREFIXES,
  SUPPRESSION_DOMAIN_ORDER,
} from "@/lib/suppression-display";
import { RULE_FINDING_REGISTRY } from "@/lib/rule-finding-prefixes";
import { MED_BRIDGE_PREFIX } from "@/lib/medication-record-match";
import { DORMANT_PRN_PREFIX } from "@/lib/dormant-prn";

describe("prefix-coverage guard (#1151)", () => {
  it("every RULE_FINDING_REGISTRY prefix has an EXPLICIT display mapping", () => {
    const missing = RULE_FINDING_REGISTRY.filter(
      (e) => !hasExplicitRegistryLabel(e.prefix)
    ).map((e) => e.prefix);
    expect(
      missing,
      "add a label template to REGISTRY_LABELS in lib/suppression-display.ts " +
        "for each new finding namespace — the central Snoozed & dismissed view " +
        "must be able to name every silenced finding"
    ).toEqual([]);
  });

  it("every registry prefix resolves to a non-empty label + a tier-matching domain", () => {
    for (const e of RULE_FINDING_REGISTRY) {
      const d = resolveSuppressedKeyDisplay(`${e.prefix}some:subject`);
      expect(d, e.prefix).not.toBeNull();
      expect(d!.label.length, e.prefix).toBeGreaterThan(0);
      expect(d!.domain, e.prefix).toBe(e.tier === "care" ? "Care" : "Coaching");
    }
  });

  it("the care/suggestion namespaces resolve too", () => {
    const keys = [
      "dose:12",
      "refill:7",
      "appointment:3",
      "screening:colorectal_cancer",
      "visit:well_adult",
      "immunization:mmr",
      "careplan:9",
      "goal:4",
      "training:2",
      "endurance-event:5",
      "med-monitor:1:tsh",
      "biomarker:ldl cholesterol",
      "biomarker-flag:ldl cholesterol",
      "trajectory:ldl:worsening",
      "prn-max:3",
      "dietary-limit:vitamin_a",
      "rda-adequacy:iron",
      "interaction:2-5",
      "pgx:1:cyp2d6:poor",
      "allergy-med:1-2",
      "contrast:procedure:4:egfr:iodinated",
      "dental-safety:2:bisphosphonate",
      "ototoxic:6",
      "food-timing:3:grapefruit",
      "keep-apart:1-2",
      "coaching:rest-sleep",
      "digest:bio:LDL:up",
      `${MED_BRIDGE_PREFIX}amoxicillin`,
      `${DORMANT_PRN_PREFIX}9`,
      "condition-consideration:asthma",
    ];
    for (const k of keys) {
      const d = resolveSuppressedKeyDisplay(k);
      expect(d, k).not.toBeNull();
      expect(d!.label.length, k).toBeGreaterThan(0);
      expect(SUPPRESSION_DOMAIN_ORDER).toContain(d!.domain);
    }
  });

  it("prefixes are unique (no namespace owned twice)", () => {
    expect(new Set(SUPPRESSION_DISPLAY_PREFIXES).size).toBe(
      SUPPRESSION_DISPLAY_PREFIXES.length
    );
  });
});

describe("label templates parse the subject out of the key", () => {
  it("training-obs plateau/stale name the exercise (the #1151 example)", () => {
    expect(
      resolveSuppressedKeyDisplay("training-obs:plateau:bench press")!.label
    ).toBe("Plateau — Bench Press");
    expect(
      resolveSuppressedKeyDisplay("training-obs:stale:deadlift")!.label
    ).toBe("Stale exercise — Deadlift");
    expect(
      resolveSuppressedKeyDisplay("training-obs:balance:push-pull")!.label
    ).toBe("Push/pull balance");
  });

  it("suggestions name their subject (#531 — label by what differs)", () => {
    expect(
      resolveSuppressedKeyDisplay(`${MED_BRIDGE_PREFIX}amoxicillin`)!.label
    ).toBe("Untracked prescription — Amoxicillin");
    expect(resolveSuppressedKeyDisplay(`${DORMANT_PRN_PREFIX}9`)!.label).toBe(
      "Dormant PRN suggestion"
    );
  });

  it("biomarker keys name the analyte", () => {
    expect(
      resolveSuppressedKeyDisplay("biomarker-flag:ldl cholesterol")!.label
    ).toBe("Flagged result — Ldl Cholesterol");
    expect(resolveSuppressedKeyDisplay("biomarker:glucose")!.label).toBe(
      "Retest — Glucose"
    );
  });
});

describe("orphan/unknown keys (#203)", () => {
  it("an unknown namespace resolves to null; the orphan display is the generic clearable row", () => {
    expect(resolveSuppressedKeyDisplay("no-such-namespace:1")).toBeNull();
    const orphan = orphanSuppressionDisplay();
    expect(orphan.label).toBe(ORPHAN_SUPPRESSION_LABEL);
    expect(orphan.domain).toBe("Other");
  });

  it("domainForRichKey falls back to the care group for an unmapped rich key", () => {
    expect(domainForRichKey("dose:1")).toBe("Due & scheduled");
    expect(domainForRichKey("mystery:1")).toBe("Due & scheduled");
  });
});
