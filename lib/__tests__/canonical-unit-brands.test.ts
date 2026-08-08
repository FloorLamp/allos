// THE CANONICAL-UNIT BRANDS (#2149 item 2).
//
// "Canonical storage uses kilograms and kilometers; convert only at the boundaries"
// had no guard at any tier — no scan, no type, only review. `Kg` and `Km` are that
// guard, so this file is BOTH halves of proving it:
//
//   • the RUNTIME half — the minters are the only way to produce a branded value, and
//     what they produce is an ordinary number, so nothing about the stored data moves;
//   • the COMPILE-TIME half — a deliberate `@ts-expect-error` at each narrowed storage
//     writer, which FAILS THE BUILD if that writer ever stops demanding the brand.
//     `@ts-expect-error` is an assertion in both directions: the line must error, and
//     tsc reports "unused '@ts-expect-error' directive" if it stops erroring. That is
//     the compile-time equivalent of a proven-on-the-defect test, and it is why these
//     cases live in a real spec file rather than in prose.
//
// The negative cases below are all the SAME defect: a display-unit number handed
// straight to storage. 154 lb stored as "154 kg" is the classic silent corruption in a
// units-preference app — it never throws, never looks wrong in the writer, and is
// indistinguishable from a real reading once it lands.

import { describe, expect, it } from "vitest";
import { toKg, toKm, resolveWeightKg, type Kg, type Km } from "@/lib/units";
// Type-only: these pull in @/lib/db at runtime, and this is the pure tier. The
// declarations below are erased entirely, so the narrowed writers' own signatures are
// checked here without a database ever being opened.
import type {
  NormActivity,
  NormBodyMetric,
} from "@/lib/integrations/normalize";
import type { recordReading } from "@/lib/reading-writes";
import type { DocBodyMetric } from "@/lib/body-metric-extract";

const DAY = "2026-01-05";

describe("the minters", () => {
  it("convert a display-unit value to canonical, and are the identity on canonical", () => {
    // 154 lb is ~69.85 kg — the gap this brand exists to keep out of storage.
    expect(toKg(154, "lb")).toBeCloseTo(69.85, 2);
    expect(toKm(3, "mi")).toBeCloseTo(4.828, 3);
    // BIT-EXACT on the canonical unit. The whole re-mint convention depends on this:
    // a value read back out of the database, or summed from canonical parts, declares
    // itself canonical through `toKg(v, "kg")` / `toKm(v, "km")` — and that must not
    // perturb the number by so much as a float ulp.
    expect(toKg(80.6, "kg")).toBe(80.6);
    expect(toKm(4.828, "km")).toBe(4.828);
  });

  it("mint an ordinary number — the brand is erased at runtime", () => {
    const kg: Kg = toKg(154, "lb");
    const km: Km = toKm(3, "mi");
    expect(typeof kg).toBe("number");
    expect(kg + 1).toBe(toKg(154, "lb") + 1);
    expect(JSON.stringify({ kg: toKg(80, "kg"), km })).toBe(
      `{"kg":80,"km":${toKm(3, "mi")}}`
    );
  });

  it("keep resolveWeightKg's #194 stored-value branch exactly intact", () => {
    // The stored branch re-mints through the identity conversion, so an untouched
    // edit-form round trip still returns the stored kg unchanged rather than the
    // rounding-quantum drift #194 fixed.
    expect(resolveWeightKg(177.5, 80.512, "lb")).toBe(80.512);
  });
});

describe("the narrowed storage writers reject an unbranded number", () => {
  it("upsertBodyMetrics' weight_kg", () => {
    const rejected: NormBodyMetric = {
      date: DAY,
      // @ts-expect-error 154 is a bare number — as far as the write path can tell it
      // is the user's POUNDS, and `body_metrics.weight_kg` stores kilograms.
      weight_kg: 154,
    };
    const accepted: NormBodyMetric = { date: DAY, weight_kg: toKg(154, "lb") };
    // The directive above is the real assertion; these pin the corruption it prevents.
    expect(rejected.weight_kg).toBe(154);
    expect(accepted.weight_kg).toBeCloseTo(69.85, 2);
  });

  it("the document-import projection's weight_kg", () => {
    // The other ingest route into `body_metrics.weight_kg`. A clinical report states
    // its own unit ("180 lb"), which is exactly why this path may not be the one
    // writer left taking a bare number.
    const rejected: DocBodyMetric = {
      date: DAY,
      // @ts-expect-error a document's reported weight must pass through `weightToKg`,
      // which reads the report's stated unit and mints the canonical value.
      weight_kg: 180,
      body_fat_pct: null,
      resting_hr: null,
    };
    expect(rejected.weight_kg).toBe(180);
  });

  it("the activity writer's distance_km", () => {
    const rejected: NormActivity = {
      external_id: "brand-check:run",
      date: DAY,
      type: "cardio",
      title: "Evening run",
      duration_min: 30,
      // @ts-expect-error 3.1 is a bare number — MILES on a mi-preference login, or
      // metres straight off a provider payload; `activities.distance_km` stores km.
      distance_km: 3.1,
      start_time: null,
      end_time: null,
    };
    expect(rejected.distance_km).toBe(3.1);
    const accepted: Km | null = toKm(3.1, "mi");
    expect(accepted).toBeCloseTo(4.989, 3);
  });

  it("the reading write core's value, where the unit is a canonical one", () => {
    // `recordReading`'s OWN parameter type at unit "kg" — read off the function rather
    // than restated, so this cannot drift from the signature it is guarding.
    type KgReading = Parameters<typeof recordReading<"kg">>[1];
    const rejected: KgReading = {
      name: "Weight",
      // @ts-expect-error the reading states kilograms, so its value must BE kilograms.
      value: 154,
      unit: "kg",
      date: DAY,
    };
    expect(rejected.value).toBe(154);

    // A reading whose canonical unit is NOT branded passes an ordinary number through
    // exactly as before — the brand reaches the two units it is about and no further.
    type MmHgReading = Parameters<typeof recordReading<"mmHg">>[1];
    const systolic: MmHgReading = {
      name: "Blood Pressure Systolic",
      value: 118,
      unit: "mmHg",
      date: DAY,
    };
    expect(systolic.value).toBe(118);
  });
});
