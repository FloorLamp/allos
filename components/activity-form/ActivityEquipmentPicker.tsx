"use client";

import type { ActivityType, Equipment } from "@/lib/types";
import { equipmentForActivityType } from "@/lib/activity-equipment";

// The session-level equipment picker (issue #342): one piece of gear for a whole
// non-strength activity — a bike for a ride, shoes for a run, recovery gear for a
// recovery session. Reusable across every non-strength surface (CardioFields and
// beyond) so the cardio picker (#339) and the recovery picker (#344) are the SAME
// component over the SAME activities.equipment_id link, not parallel one-offs.
//
// It filters the profile's equipment to the kinds that fit the activity type
// (equipmentForActivityType) and renders a plain <select> with a "None" option.
// When the profile owns no gear of a fitting kind the picker renders nothing — a
// user with no bikes/shoes never sees an empty control. Recency defaulting lives in
// the parent (it seeds `value`), keeping this component a pure controlled select.
export default function ActivityEquipmentPicker({
  activityType,
  equipment,
  value,
  onChange,
}: {
  activityType: ActivityType;
  equipment: Equipment[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const options = equipmentForActivityType(equipment, activityType);
  // A previously-linked row that no longer fits the filter (e.g. its category was
  // changed) must still be selectable so an edit doesn't silently drop the link.
  const selectedMissing =
    value != null && !options.some((e) => e.id === value)
      ? equipment.find((e) => e.id === value)
      : undefined;
  if (options.length === 0 && !selectedMissing) return null;

  return (
    <div className="mt-2">
      <label className="label" htmlFor="activity-equipment">
        Equipment
      </label>
      <select
        id="activity-equipment"
        data-testid="activity-equipment-select"
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value ? Number(e.target.value) : null)
        }
        className="input bg-white dark:bg-ink-900"
      >
        <option value="">None</option>
        {options.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
        {selectedMissing && (
          <option value={selectedMissing.id}>{selectedMissing.name}</option>
        )}
      </select>
    </div>
  );
}
