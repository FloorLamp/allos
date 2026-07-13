"use client";

import Link from "next/link";
import type { ActivityType, Equipment } from "@/lib/types";
import { equipmentForActivity } from "@/lib/activity-equipment";

// The session-level equipment picker (issue #342): one piece of gear for a whole
// non-strength activity — a bike for a ride, shoes for a run, recovery gear for a
// recovery session. Reusable across every non-strength surface (CardioFields and
// beyond) so the cardio picker (#339) and the recovery picker (#344) are the SAME
// component over the SAME activities.equipment_id link, not parallel one-offs.
//
// It filters the profile's equipment to the gear that fits the activity
// (equipmentForActivity — cardio narrows by name to shoes for a run, bikes for a
// ride per issue #339) and renders a plain <select> with a "None" option. When the
// profile owns no fitting gear it renders an empty-state "Add equipment" door to the
// /equipment registry instead of a <select> — that link is the ONE bootstrap path to
// the registry for a profile with no gear (issue #592: every other entry point was
// gated on already having equipment, so returning null hid the only door). Recency
// defaulting lives in the parent (it seeds `value`), keeping this a controlled select.
export default function ActivityEquipmentPicker({
  activityType,
  activityName = null,
  equipment,
  value,
  onChange,
}: {
  activityType: ActivityType;
  activityName?: string | null;
  equipment: Equipment[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const options = equipmentForActivity(equipment, activityType, activityName);
  // A previously-linked row that no longer fits the filter (e.g. its category was
  // changed) must still be selectable so an edit doesn't silently drop the link.
  const selectedMissing =
    value != null && !options.some((e) => e.id === value)
      ? equipment.find((e) => e.id === value)
      : undefined;
  const isEmpty = options.length === 0 && !selectedMissing;

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <label className="label" htmlFor="activity-equipment">
          Equipment
        </label>
        {/* Contextual link to the registry (issue #343) — equipment lives at
        /equipment now, reached from where gear appears rather than top-level nav.
        The empty-state variant is the bootstrap door (#592): with no gear on file
        this is the only path to /equipment, so we render it instead of hiding. */}
        <Link
          href="/equipment"
          target="_blank"
          data-testid="activity-equipment-link"
          className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          {isEmpty ? "Add equipment →" : "Manage equipment"}
        </Link>
      </div>
      {isEmpty ? (
        <p
          className="mt-1 text-xs text-slate-400 dark:text-slate-500"
          data-testid="activity-equipment-empty"
        >
          No gear on file yet — add your bikes, shoes, or recovery devices to
          link them to a session.
        </p>
      ) : (
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
      )}
    </div>
  );
}
