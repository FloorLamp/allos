import type { IntakeItemKind } from "@/lib/types";

// IntakeItemForm has no generic chooser surface. Its host owns one of the two
// shipped doors, and this runtime boundary keeps untyped or older clients aligned
// with the required React prop.
export function requireIntakeFormKind(value: unknown): IntakeItemKind {
  if (value !== "medication" && value !== "supplement") {
    throw new Error("IntakeItemForm requires a locked intake kind");
  }
  return value;
}
