"use client";

import { useRef, useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import { useCreateActionLabel } from "@/components/CreateAction";
import PracticeEditor from "./PracticeEditor";

export default function AddPracticeButton({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // ONE PHRASE FOR THE TRIGGER AND ITS DIALOG (#5300 rule 6, #5617 step 2). The
  // registry used to carry a second title for this one kind — "Add a practice" over
  // the dialog, "Add practice" on the control that opened it — and it was the only
  // entry that did, so the whole seam existed to hold one article.
  const label = useCreateActionLabel();
  const practiceInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        className="btn shrink-0 whitespace-nowrap"
        onClick={() => setOpen(true)}
        aria-label={label}
        data-testid="practice-create-trigger"
      >
        <IconPlus className="h-4 w-4" stroke={2} aria-hidden />
        <span className="hidden sm:inline">Add</span>
      </button>
      {open && (
        <ModalShell
          title={label}
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
