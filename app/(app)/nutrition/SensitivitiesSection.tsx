import { EmptyState } from "@/components/ui";
import { SectionCreateHeader } from "@/components/CreateAction";
import CatalogEditor from "@/components/CatalogEditor";
import CatalogRow from "@/components/CatalogRow";
import CatalogLifecycleControl from "@/components/CatalogLifecycleControl";
import { triggerLabel, type FoodSensitivity } from "@/lib/food-sensitivities";
import { SENSITIVITY_CATALOG } from "./sensitivity-catalog";

// The declared food sensitivities, as a #5237 catalog section on the Nutrition Manage
// tab (#5865, owner ruling 2 of 2026-09-11: here, not on Records beside allergies and
// not on Trends beside stool).
//
// ITS OWN FILE rather than another region of ManageTab.tsx, which is the better
// factoring whatever the size rule says: this section reads one list, renders one
// catalog, and shares nothing with the supplement schedule it sits under.
//
// A SENSITIVITY IS NOT AN ALLERGY, and the copy is the only place a person can be told
// so. The subtitle says what the declaration DOES — it is tracked, it never warns — because
// the surface next to it (Food preferences) also never gates, and a reader who has met
// the allergy list has every reason to expect this one to behave like it.
//
// A STOPPED ROW STAYS ON THE LIST, the way retired equipment does: stopping is how you
// keep the declaration and its explanation of past marks while taking the chip and the
// pair away, and a row that vanished on Stop would make that indistinguishable from
// Delete.
export default function SensitivitiesSection({
  sensitivities,
}: {
  sensitivities: FoodSensitivity[];
}) {
  const catalog = SENSITIVITY_CATALOG;
  return (
    <section data-testid="food-sensitivities-card" className="card space-y-3">
      <SectionCreateHeader
        title="Food sensitivities"
        subtitle="Not allergies. Say what sets something off and what it does, and the app will keep track of it — it never warns, blocks, or changes what you can log."
        createAction={{
          kind: "sensitivity",
          control: (
            <CatalogEditor
              create
              title="Add sensitivity"
              Form={catalog.Form}
              formProps={{}}
            />
          ),
        }}
      />
      {sensitivities.length === 0 ? (
        <EmptyState message="Nothing declared. Add one if a food or a kind of meal reliably does something to you." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {sensitivities.map((item) => (
            <CatalogRow
              key={item.id}
              name={triggerLabel(item.trigger_kind, item.trigger_slug)}
              facts={catalog.facts(item)}
              kind={catalog.label}
              inactive={item.status === "stopped"}
              inactiveLabel={catalog.lifecycle.past}
              testId="food-sensitivity-row"
              editor={{
                Form: catalog.Form,
                title: "Edit sensitivity",
                formProps: { sensitivity: item },
              }}
              control={
                <CatalogLifecycleControl
                  name={triggerLabel(item.trigger_kind, item.trigger_slug)}
                  inactive={item.status === "stopped"}
                  lifecycle={catalog.lifecycle}
                  action={catalog.setInactive.bind(null, item.id)}
                  testId="food-sensitivity-stop-toggle"
                />
              }
              deleteAction={catalog.remove.bind(null, item.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
