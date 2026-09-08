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

// Pending entries keep adoption explicit without inventing replacement lifecycles.
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
