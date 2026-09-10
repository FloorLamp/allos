import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyFoodServingPlacements,
  applyFoodServingTruth,
  setFoodServingCount,
} from "@/lib/food-serving-projection";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RECEIPT_SCOPE_CAPTURE =
  "const noticeScope = currentReceiptProfileScope();";

function receiptScopeErrors(source: string): string[] {
  const errors: string[] = [];
  if (source.split(RECEIPT_SCOPE_CAPTURE).length - 1 !== 4)
    errors.push("every interaction must capture the current receipt scope");
  if (/\b(?:profileToast|offerEndFast|undoEnd)\(\s*null\b/.test(source))
    errors.push("a food outcome bypasses its captured receipt scope");
  if (
    !source.includes("reserveToastLifecycle") ||
    !source.includes("onlyIfOwner: true")
  )
    errors.push("food receipts are missing lifecycle ownership");
  return errors;
}

function replaceOccurrence(
  source: string,
  needle: string,
  replacement: string,
  occurrence: number
): string {
  let from = 0;
  let at = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    at = source.indexOf(needle, from);
    if (at < 0) throw new Error(`missing mutation target: ${needle}`);
    from = at + needle.length;
  }
  return source.slice(0, at) + replacement + source.slice(at + needle.length);
}

describe("applyFoodServingPlacements", () => {
  it("publishes both halves of a same-group meal correction as one projection", () => {
    const projected = applyFoodServingPlacements(
      {
        "2026-08-24": { nuts_seeds: 1, berries: 2 },
      },
      {
        "2026-08-24": {
          Morning: { nuts_seeds: 1, berries: 1 },
          Midday: { berries: 1 },
          Evening: {},
        },
      },
      [
        {
          date: "2026-08-24",
          groupKey: "nuts_seeds",
          mealSlot: "Morning",
          servings: 1,
          mealServings: 0,
        },
        {
          date: "2026-08-24",
          groupKey: "nuts_seeds",
          mealSlot: "Evening",
          servings: 1,
          mealServings: 1,
        },
      ]
    );

    expect(projected.countsByDate["2026-08-24"]).toEqual({
      nuts_seeds: 1,
      berries: 2,
    });
    expect(projected.slotCountsByDate["2026-08-24"]).toEqual({
      Morning: { nuts_seeds: 0, berries: 1 },
      Midday: { berries: 1 },
      Evening: { nuts_seeds: 1 },
    });
  });

  it("keeps browser projection publication on one provider state boundary", () => {
    const provider = readFileSync(
      `${ROOT}/app/(app)/nutrition/FoodSuggestionsLayout.tsx`,
      "utf8"
    );
    const bar = readFileSync(
      `${ROOT}/app/(app)/nutrition/FoodLogBar.tsx`,
      "utf8"
    );

    expect(provider).toContain("useState<FoodProjectionState>");
    expect(provider).not.toContain("setCountsByDate");
    expect(provider).not.toContain("setSlotCountsByDate");
    expect(provider.match(/key=\{activeProfileId/g)).toHaveLength(2);
    expect(bar).toContain("setProjection(next)");
    expect(bar).not.toContain("setCountsByDate");
    expect(bar).not.toContain("setSlotCountsByDate");
  });

  it("stamps every food interaction receipt with its captured profile generation", () => {
    const bar = readFileSync(
      `${ROOT}/app/(app)/nutrition/FoodLogBar.tsx`,
      "utf8"
    );
    const watcher = readFileSync(
      `${ROOT}/components/ProfileSwitchWatcher.tsx`,
      "utf8"
    );
    const undo = readFileSync(
      `${ROOT}/components/useUndoableAction.ts`,
      "utf8"
    );
    const toastProvider = readFileSync(`${ROOT}/components/Toast.tsx`, "utf8");

    // Correction, precise removal, serving add/undo, and "usual" each capture
    // the canonical root-toast scope before their first await.
    expect(receiptScopeErrors(bar)).toEqual([]);
    // One direct call is allowed: the helper itself. Every health notice goes
    // through profileToast, whose final properties cannot be overridden by a
    // caller-supplied options object.
    expect(bar.match(/\btoast\(/g)).toHaveLength(1);
    expect(bar).toMatch(
      /toast\(message, \{\s*\.\.\.options,\s*profileId: scope\.profileId,\s*profileToken: scope\.token,/s
    );
    expect(bar).toContain(
      "offerEndFast(noticeScope, outcome.endFastOffer, endFastOwner)"
    );
    expect(bar).toContain(
      "offerEndFast(noticeScope, result.endFastOffer, endFastOwner)"
    );
    expect(bar).toContain("undoEnd(scope, undoFastId, owner)");
    expect(bar).toContain("dismissToast(receiptKey, receiptOwner)");
    expect(bar).toContain("existingReceiptOwner ?? reserveToastLifecycle");
    expect(
      undo.match(/onlyIfOwner: announcement\.owner != null/g)
    ).toHaveLength(4);
    expect(toastProvider).toContain("keyedOwnersRef.current.get(options.key)");
    expect(toastProvider).toContain("dismiss(toast.id, true)");
    expect(watcher).toContain("useLayoutEffect(() => {");
    expect(watcher).not.toContain("useEffect(() => {");

    // Each interaction start is independently required. Replacing correction,
    // removal, serving/queue, or usual scope capture with null must fail.
    for (let occurrence = 0; occurrence < 4; occurrence += 1) {
      const mutant = replaceOccurrence(
        bar,
        RECEIPT_SCOPE_CAPTURE,
        "const noticeScope = null;",
        occurrence
      );
      expect(receiptScopeErrors(mutant)).not.toEqual([]);
    }

    // Pin the downstream outcomes too: queue/refusal, correction/removal,
    // serving and usual fast offers, and fast Undo may not silently drop scope.
    for (const target of [
      "profileToast(noticeScope, OFFLINE_CAPTURE_REFUSED_MESSAGE",
      'profileToast(noticeScope, "Serving corrected.")',
      'profileToast(noticeScope, "Serving removed."',
      "offerEndFast(noticeScope, outcome.endFastOffer, endFastOwner)",
      // The composed bundle's answer is `usualRoutineWriteAnswer` since #4438 — the one
      // sentence every host of this bundle renders — where it used to be a food-only
      // "Logged …" built here. Same claim about scope, new spelling of the thing it is
      // asserted on.
      "profileToast(\n          noticeScope,\n          usualRoutineWriteAnswer(",
      "offerEndFast(noticeScope, result.endFastOffer, endFastOwner)",
      "undoEnd(scope, undoFastId, owner)",
    ]) {
      const mutant = bar.replace(
        target,
        target.replace(
          target.includes("noticeScope") ? "noticeScope" : "scope",
          "null"
        )
      );
      expect(mutant).not.toBe(bar);
      expect(receiptScopeErrors(mutant)).not.toEqual([]);
    }
  });
});

describe("setFoodServingCount", () => {
  it("moves the day and meal halves of one coordinate together and floors at zero", () => {
    const projected = setFoodServingCount(
      { "2026-08-24": { berries: 1, nuts_seeds: 4 } },
      {
        "2026-08-24": {
          Morning: { berries: 1 },
          Midday: { nuts_seeds: 4 },
          Evening: {},
        },
      },
      "2026-08-24",
      "Morning",
      "berries",
      (prev) => ({ day: prev.day - 3, meal: prev.meal - 3 })
    );
    expect(projected.countsByDate["2026-08-24"]).toEqual({
      berries: 0,
      nuts_seeds: 4,
    });
    expect(projected.slotCountsByDate["2026-08-24"].Morning).toEqual({
      berries: 0,
    });
    // The sibling windows the tap did not name are untouched.
    expect(projected.slotCountsByDate["2026-08-24"].Midday).toEqual({
      nuts_seeds: 4,
    });
  });

  it("starts a day the projection has never seen from zero", () => {
    const projected = setFoodServingCount(
      {},
      {},
      "2026-08-25",
      "Evening",
      "berries",
      (prev) => ({ day: prev.day + 1, meal: prev.meal + 1 })
    );
    expect(projected.countsByDate["2026-08-25"]).toEqual({ berries: 1 });
    expect(projected.slotCountsByDate["2026-08-25"].Evening).toEqual({
      berries: 1,
    });
    expect(projected.slotCountsByDate["2026-08-25"].Morning).toEqual({});
  });
});

describe("applyFoodServingTruth", () => {
  // EVERY WINDOW, not just the one that moved. A burst can spread across meals, so a
  // repair that named only the latest window would leave an earlier row optimistic
  // under a day total that had already been corrected — the two visibly disagreeing.
  it("sets the day total and all three meal windows from one server snapshot", () => {
    const projected = applyFoodServingTruth(
      { "2026-08-24": { berries: 9, nuts_seeds: 4 } },
      {
        "2026-08-24": {
          Morning: { berries: 5 },
          Midday: { berries: 4, nuts_seeds: 4 },
          Evening: { berries: 7 },
        },
      },
      "2026-08-24",
      "berries",
      { servings: 3, mealServings: { Morning: 1, Midday: 2, Evening: 0 } }
    );
    expect(projected.countsByDate["2026-08-24"].berries).toBe(3);
    expect(projected.slotCountsByDate["2026-08-24"].Morning.berries).toBe(1);
    expect(projected.slotCountsByDate["2026-08-24"].Midday.berries).toBe(2);
    expect(projected.slotCountsByDate["2026-08-24"].Evening.berries).toBe(0);
    // Another group in the same windows is not part of this coordinate's truth.
    expect(projected.countsByDate["2026-08-24"].nuts_seeds).toBe(4);
    expect(projected.slotCountsByDate["2026-08-24"].Midday.nuts_seeds).toBe(4);
  });
});
