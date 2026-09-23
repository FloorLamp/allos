"use client";

import { IconPlus } from "@tabler/icons-react";
import { useActivityEditor } from "@/components/ActivityEditorProvider";
import Button from "@/components/Button";
import { useCreateActionLabel } from "@/components/CreateAction";

// The Training Log's page-level create belongs in the page create slot (#3486/#3731).
// It stays desktop-only: below `md`, the dock's quick-log surface remains the one
// standing activity entry point.
export default function AddTrainingActivityButton() {
  const { openCreate } = useActivityEditor();
  const label = useCreateActionLabel();

  return (
    <Button
      variant="primary"
      layout="hidden-below-md"
      onClick={() => openCreate()}
      data-testid="training-log-add-activity"
    >
      <IconPlus className="h-4 w-4" stroke={2.5} />
      {label}
    </Button>
  );
}
