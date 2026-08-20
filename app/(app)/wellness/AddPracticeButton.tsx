"use client";

import { useRef, useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import PracticeEditor from "./PracticeEditor";

export default function AddPracticeButton({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const practiceInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        className="btn shrink-0 whitespace-nowrap"
        onClick={() => setOpen(true)}
        aria-label="Add practice"
        data-testid="practice-create-trigger"
      >
        <IconPlus className="h-4 w-4" stroke={2} aria-hidden />
        <span className="hidden sm:inline">Add</span>
      </button>
      {open && (
        <ModalShell
          title="Add a practice"
          onClose={() => setOpen(false)}
          initialFocusRef={practiceInputRef}
          size="sm"
        >
          <PracticeEditor
            compact
            onDone={() => setOpen(false)}
            initialFocusRef={practiceInputRef}
          />
        </ModalShell>
      )}
    </>
  );
}
