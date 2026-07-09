"use client";

import { useActivityEditor } from "./ActivityEditorProvider";

export default function LogActivityButton({
  children = "+ Log activity",
  className = "btn w-full",
  onClick,
}: {
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const { openCreate } = useActivityEditor();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        openCreate();
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}
