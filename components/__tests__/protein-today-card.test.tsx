import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProteinTodayAtom } from "@/components/dashboard/NutritionAtoms";
import { proteinIntake, proteinTarget, type ProteinToday } from "@/lib/protein";

// The dashboard's Nutrition-today card (#3257). Its Standing sibling is pinned in the
// browser by e2e/dashboard-daily-loop.spec.ts; this card had NO observer at all — an
// adversarial pass deleted its info control and its "g"/"g/day" unit and the whole
// shipped suite stayed green. The component tier (#3446) is the cheap altitude for
// exactly that: a claim that lives in a component's own DOM, not in a pure function.
const target = proteinTarget({
  goal: "active",
  bodyweightKg: 65,
  leanMassKg: null,
})!; // active 1.2–1.6 g/kg × 65 → an 80–105 g band

function today(over: Partial<ProteinToday> = {}): ProteinToday {
  const todayIntake = proteinIntake({
    dailyTracked: null,
    dailyLogged: 30,
    dailyEstimated: 39,
  })!; // basis combined, 69 g — the owner's own reading in #3257
  return {
    todayIntake,
    todayGrams: todayIntake.grams,
    target,
    weeklyAverageGrams: 117,
    trailing: { grams: 117, dayOne: false },
    ...over,
  };
}

describe("the Nutrition-today card states a number and a goal (#3257)", () => {
  it("puts the figure, the band and the trailing average on the card in plain units", () => {
    render(<ProteinTodayAtom today={today()} />);
    expect(screen.getByTestId("nutrition-today-protein").textContent).toBe(
      "69 g+"
    );
    expect(screen.getByText("Goal 80–105 g")).toBeTruthy();
    // "g", not "g/day": the label already names the window, and the row beside it
    // states the goal in the same unit. A revert to "g/day" fails HERE — the e2e
    // assertion on the Standing row is a substring match and cannot see it.
    expect(screen.getByTestId("nutrition-trailing-average").textContent).toBe(
      "7-day average · 117 g"
    );
    // Nothing on the card's face parses as machinery or as a hedge.
    expect(document.body.textContent).not.toMatch(
      /≥|g\/kg|a floor|likely higher|logged foods \+/
    );
  });

  it("keeps the derivation and the floor sentence one tap away, not deleted", () => {
    render(<ProteinTodayAtom today={today()} />);
    // The info control IS the mechanism by which #3257's honesty survives. Deleting it
    // must not be silent, so its accessible name is asserted whole.
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Goal ~80–105 g/day (1.2–1.6 g/kg, general fitness). Today's total is from foods and logged protein. Foods you haven't logged aren't counted, so your real total may be higher."
    );
  });

  it("names no source and claims no missing food before the first entry of the day", () => {
    // An established logger every morning (lib/queries/nutrition.ts returns
    // todayIntake: null, todayGrams: 0). There are no meals to be partial about.
    render(
      <ProteinTodayAtom today={today({ todayIntake: null, todayGrams: 0 })} />
    );
    expect(screen.getByTestId("nutrition-today-protein").textContent).toBe(
      "0 g+"
    );
    const label = screen.getByRole("button").getAttribute("aria-label")!;
    expect(label).toBe("Goal ~80–105 g/day (1.2–1.6 g/kg, general fitness).");
    expect(label).not.toMatch(/meals are logged|haven't logged/);
  });
});
