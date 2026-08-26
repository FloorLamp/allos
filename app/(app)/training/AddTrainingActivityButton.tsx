"use client";

import { IconPlus } from "@tabler/icons-react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import { useCreateActionLabel } from "@/components/CreateAction";

// The Training Log's page-level create belongs in the page create slot (#3486/#3731).
// It stays desktop-only: below `md`, the dock's quick-log surface remains the one
// standing activity entry point.
export default function AddTrainingActivityButton() {
  const { openCreate } = useActivityEditor();
  const label = useCreateActionLabel();

  return (
    <button
      type="button"
      onClick={() => openCreate()}
      data-testid="training-log-add-activity"
      className="btn hidden md:inline-flex"
    >
      <IconPlus className="h-4 w-4" stroke={2.5} />
      {label}
    </button>
  );
}
