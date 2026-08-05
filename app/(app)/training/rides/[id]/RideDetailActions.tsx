"use client";

import { useActivityEditor } from "@/components/ActivityEditorProvider";
import type { ActivityEditData } from "@/lib/activity-form-model";

export default function RideDetailActions({
  activity,
  canWrite,
}: {
  activity: ActivityEditData;
  canWrite: boolean;
}) {
  const { openEdit } = useActivityEditor();
  if (!canWrite) return null;
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => openEdit(activity)}
    >
      Edit ride
    </button>
  );
}
