"use client";

import { useActivityEditor } from "./ActivityEditorProvider";
import Button from "./Button";

export default function LogActivityButton({
  children = "+ Log activity",
  onClick,
  testId,
}: {
  children?: React.ReactNode;
  onClick?: () => void;
  testId?: string;
}) {
  const { openCreate, trainingRelevant } = useActivityEditor();
  if (!trainingRelevant) return null;
  return (
    <Button
      data-testid={testId}
      onClick={() => {
        openCreate();
        onClick?.();
      }}
    >
      {children}
    </Button>
  );
}
