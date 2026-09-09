import type { IntakeFormContext } from "@/lib/intake-form-context";

export function intakeFormContext(
  todayStr: string,
  overrides: Partial<IntakeFormContext> = {}
): IntakeFormContext {
  return {
    allIntakeItems: [],
    stackItems: [],
    pgxVariants: [],
    conditions: [],
    pediatric: {
      ageMonths: null,
      weightKg: null,
      weightDate: null,
      weightUnit: "kg",
      today: todayStr,
      declinedDoseUpdates: [],
    },
    todayStr,
    ...overrides,
  };
}
