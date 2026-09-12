import "server-only";

import type { ComponentType, ReactNode } from "react";
import type { CreateActionKind } from "@/components/CreateAction";
import type { CatalogLifecycle } from "@/components/CatalogLifecycleControl";
import type { CatalogFormCallbacks } from "@/components/CatalogEditor";
import type { EquipmentFormProps } from "@/components/EquipmentForm";
import type { OwnedTable } from "@/lib/owned-tables";
import EquipmentForm from "@/components/EquipmentForm";
import { setEquipmentRetiredAction } from "@/app/(app)/equipment/actions";
import { getEquipmentUsage } from "@/lib/queries/equipment";
import type { Equipment } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import { kgTo, round } from "@/lib/units";
import type { SensitivityFormProps } from "@/app/(app)/nutrition/SensitivityForm";
import type { FoodSensitivity } from "@/lib/food-sensitivities";
import type {
  deleteFoodSensitivityAction,
  setFoodSensitivityStoppedAction,
} from "@/app/(app)/nutrition/sensitivity-actions";
import { SENSITIVITY_CATALOG } from "@/app/(app)/nutrition/sensitivity-catalog";

// Pending entries keep adoption explicit without inventing replacement lifecycles.
//
// THE ADOPTED ARM IS PER DOMAIN, not one generic shape, and the second adopter is what
// settled that (#5865). What the shared catalog actually fixes is the ROW — the name,
// the facts line, the ⋯ menu, the lifecycle control, the editor dialog — and the
// registry's job is to say which kinds have adopted it and to hold the pieces each one
// hands the row. The pieces themselves do not generalise: equipment's facts line needs
// the weight unit and a session count, a sensitivity's needs nothing at all, and a
// signature wide enough for both would be a signature neither one type-checks against.
export type CatalogManifest =
  | { adoption: "pending"; reason: string }
  | {
      adoption: "shared";
      table: OwnedTable;
      label: string;
      lifecycle: CatalogLifecycle;
      Form: ComponentType<EquipmentFormProps & CatalogFormCallbacks<Equipment>>;
      facts: (item: Equipment, unit: WeightUnit, sessions: number) => ReactNode;
      usage: typeof getEquipmentUsage;
      setInactive: typeof setEquipmentRetiredAction;
    }
  | {
      adoption: "shared";
      table: OwnedTable;
      label: string;
      lifecycle: CatalogLifecycle;
      Form: ComponentType<
        SensitivityFormProps & CatalogFormCallbacks<FoodSensitivity>
      >;
      facts: (item: FoodSensitivity) => ReactNode;
      setInactive: typeof setFoodSensitivityStoppedAction;
      // A declaration written by mistake has nothing to keep: no log references it, and
      // the marks it explains are facts about their own meals either way. So this is the
      // one catalog so far that offers a delete beside its lifecycle verb.
      remove: typeof deleteFoodSensitivityAction;
    };

export const CATALOGS = {
  equipment: {
    adoption: "shared",
    table: "equipment",
    label: "Equipment",
    lifecycle: {
      verb: "Retire",
      reverse: "Restore",
      past: "Retired",
      reversePast: "Restored",
      dated: false,
    },
    Form: EquipmentForm,
    facts: (item: Equipment, unit: WeightUnit, sessions: number) => (
      <>
        {item.category ?? "Uncategorized"} ·{" "}
        {item.weight_kg == null
          ? "Weight not set"
          : `${round(kgTo(item.weight_kg, unit), 2)} ${unit}`}
        {sessions > 0 && (
          <>
            {" "}
            ·{" "}
            <span data-testid="equipment-usage">
              {sessions} {sessions === 1 ? "session" : "sessions"}
            </span>
          </>
        )}
      </>
    ),
    usage: getEquipmentUsage,
    setInactive: setEquipmentRetiredAction,
  },
  // The Nutrition Manage tab's declared food sensitivities (#5865). The owner's ruling
  // (2026-09-11) put them here rather than on Records beside allergies or on Trends
  // beside stool: a sensitivity is a preference-tier statement about eating, and Manage
  // is where the profile's standing food choices already live (#975).
  //
  // Declared in app/(app)/nutrition/sensitivity-catalog.tsx and imported, not written
  // out here: the section that renders the row cannot read THIS file (see that file's
  // header for the `server-only` edge), so the definition sits where both can see it.
  sensitivity: SENSITIVITY_CATALOG,
  medication: {
    adoption: "pending",
    reason:
      "The Current/Past board retains its dated course-stop lifecycle; adoption belongs to #5344.",
  },
  supplement: {
    adoption: "pending",
    reason:
      "Manage retains its pause lifecycle and dated item state; adoption belongs to #5344.",
  },
  practice: {
    adoption: "pending",
    reason:
      "Practices have no retirement state; their identity/editor needs its own adoption.",
  },
  "training-activity": {
    adoption: "pending",
    reason:
      "Activities are logged events with a persistent editor, not a retireable registry.",
  },
  protocol: {
    adoption: "pending",
    reason:
      "Ending a bounded experiment reconciles domain state; retain the protocol lifecycle.",
  },
  goal: {
    adoption: "pending",
    reason:
      "Targets retain their status and ledger semantics until their catalog adoption.",
  },
  routine: {
    adoption: "pending",
    reason:
      "Routines retain their active flag and editor until their catalog adoption.",
  },
} satisfies Record<CreateActionKind, CatalogManifest>;
