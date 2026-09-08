import type { Equipment, EquipmentKind } from "@/lib/types";
import { kindOf } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import { equipmentHref } from "@/lib/hrefs";
import { CATALOGS } from "@/components/catalog";
import { EmptyState } from "./ui";
import { SectionCreateHeader } from "./CreateAction";
import CatalogEditor from "./CatalogEditor";
import CatalogRow from "./CatalogRow";
import CatalogLifecycleControl from "./CatalogLifecycleControl";

const KIND_LABELS: { kind: EquipmentKind; label: string }[] = [
  { kind: "strength", label: "Strength" },
  { kind: "cardio", label: "Cardio" },
  { kind: "recovery", label: "Recovery" },
  { kind: "other", label: "Other" },
];

export default function EquipmentManager({
  equipment,
  unit,
  usage,
  creationAvailable = true,
  strengthTrainingAvailable = true,
}: {
  equipment: Equipment[];
  unit: WeightUnit;
  usage: Record<number, { sessions: number }>;
  creationAvailable?: boolean;
  strengthTrainingAvailable?: boolean;
}) {
  const catalog = CATALOGS.equipment;
  const groups = KIND_LABELS.filter(
    ({ kind }) => strengthTrainingAvailable || kind !== "strength"
  ).map(({ kind, label }) => ({
    label,
    rows: equipment.filter((e) => !e.retired && kindOf(e.category) === kind),
  }));
  groups.push({ label: "Retired", rows: equipment.filter((e) => e.retired) });
  return (
    <div className="card space-y-4">
      <SectionCreateHeader
        title="Your equipment"
        createAction={{
          kind: "equipment",
          available: creationAvailable,
          control: (
            <CatalogEditor
              create
              title="Add equipment"
              Form={catalog.Form}
              formProps={{ unit, strengthTrainingAvailable }}
            />
          ),
        }}
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {!creationAvailable
          ? "Existing equipment stays here with its activity history."
          : strengthTrainingAvailable
            ? "Name a bar, implement, or recovery device to tag your sessions with it. Logged weights are always the total load; equipment weight here is only a reference."
            : "Name cardio gear or a recovery device to tag activities with it."}
      </p>
      {equipment.length === 0 ? (
        <EmptyState
          message={
            !creationAvailable
              ? "No equipment on file."
              : strengthTrainingAvailable
                ? "No equipment defined yet. Add a trap bar, a bike, a pair of shoes, or a sauna."
                : "No equipment defined yet. Add a bike, a pair of shoes, or recovery gear."
          }
        />
      ) : (
        groups
          .filter((g) => g.rows.length)
          .map((group) => (
            <div key={group.label}>
              <h3 className="mb-1 section-label">{group.label}</h3>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {group.rows.map((item) => (
                  <CatalogRow
                    key={item.id}
                    name={item.name}
                    href={equipmentHref(item.id)}
                    facts={catalog.facts(
                      item,
                      unit,
                      usage[item.id]?.sessions ?? 0
                    )}
                    kind={catalog.label}
                    inactive={!!item.retired}
                    inactiveLabel={catalog.lifecycle.past}
                    testId="equipment-row"
                    editor={{
                      Form: catalog.Form,
                      title: "Edit equipment",
                      formProps: {
                        equipment: item,
                        unit,
                        strengthTrainingAvailable,
                      },
                    }}
                    control={
                      <CatalogLifecycleControl
                        name={item.name}
                        inactive={!!item.retired}
                        lifecycle={catalog.lifecycle}
                        action={catalog.setInactive.bind(null, item.id)}
                        testId="equipment-retire-toggle"
                      />
                    }
                  />
                ))}
              </ul>
            </div>
          ))
      )}
    </div>
  );
}
