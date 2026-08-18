"use client";

import Link from "next/link";
import { useActivityEditor } from "@/components/ActivityEditorProvider";

export default function EquipmentRegistryLink({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId: string;
}) {
  const { leaveFor } = useActivityEditor();
  return (
    <Link
      href="/equipment"
      data-testid={testId}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        void leaveFor("/equipment");
      }}
      className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
    >
      {children}
    </Link>
  );
}
