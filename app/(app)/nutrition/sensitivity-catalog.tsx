import type { CatalogLifecycle } from "@/components/CatalogLifecycleControl";
import type { OwnedTable } from "@/lib/owned-tables";
import SensitivityForm from "./SensitivityForm";
import {
  deleteFoodSensitivityAction,
  setFoodSensitivityStoppedAction,
} from "./sensitivity-actions";
import {
  sensitivityFactsLine,
  type FoodSensitivity,
} from "@/lib/food-sensitivities";

// The declared food sensitivities' entry in the #5237 catalog registry (#5865) — the
// pieces the shared row is handed: its form, its facts line, its lifecycle verb and its
// two writes.
//
// IT LIVES HERE RATHER THAN INSIDE components/catalog.tsx, which is where the registry
// itself is, and the reason is a hard edge rather than taste. That file opens with
// `import "server-only"`, a marker only Next's build resolves — no package of that name
// is installed — so any module graph a test walks into that reaches it fails to
// transform. The Manage tab is rendered by the action tier, and the section below is
// mounted on it, so reading the registry from the section would have pulled the marker
// into a tier that cannot resolve it. The registry imports THIS, one direction only,
// and both readers still see one definition.
export const SENSITIVITY_CATALOG = {
  adoption: "shared",
  table: "food_sensitivities" as OwnedTable,
  label: "Sensitivity",
  // STOP TRACKING, NOT RETIRE. The declaration stays on the list either way — what
  // stops is the counting, and the word says so.
  lifecycle: {
    verb: "Stop tracking",
    reverse: "Track again",
    past: "Stopped tracking",
    reversePast: "Tracking",
    dated: false,
  } satisfies CatalogLifecycle,
  Form: SensitivityForm,
  facts: (item: FoodSensitivity) => sensitivityFactsLine(item),
  setInactive: setFoodSensitivityStoppedAction,
  // A declaration written by mistake has nothing to keep: no log references it, and the
  // marks it explains are facts about their own meals either way. So this is the one
  // catalog so far that offers a delete beside its lifecycle verb.
  remove: deleteFoodSensitivityAction,
} as const;
