"use client";

import { useActivityEditor } from "./ActivityEditorProvider";

export default function LogActivityButton({
  children = "+ Log activity",
  className = "btn w-full",
  onClick,
  testId,
}: {
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const { openCreate } = useActivityEditor();
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      onClick={() => {
        openCreate();
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}
