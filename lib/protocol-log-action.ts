// Pure protocol-scope → existing logger dispatch (#1584). The UI component and
// its tests share this mapping so a scope kind cannot silently lose its action.
// No write path lives here: each variant points at the editor that already owns
// that ledger.

import { PRACTICE_TYPES, type PracticeType } from "./protocol-practice";

export type ProtocolPracticeScope = "type" | "food_group" | "practice";

export type ProtocolLogAction =
  | {
      kind: "activity";
      type: PracticeType;
      label: string;
    }
  | {
      kind: "food";
      foodGroup: string;
      label: string;
    }
  | {
      kind: "practice";
      practice: string;
      label: string;
    };

export function protocolLogAction(
  scopeKind: ProtocolPracticeScope,
  value: string
): ProtocolLogAction | null {
  if (scopeKind === "practice") {
    return { kind: "practice", practice: value, label: "Log session" };
  }
  if (scopeKind === "food_group") {
    return { kind: "food", foodGroup: value, label: "Log servings" };
  }
  if (!PRACTICE_TYPES.includes(value as PracticeType)) return null;
  return {
    kind: "activity",
    type: value as PracticeType,
    label: `Log ${value} session`,
  };
}
