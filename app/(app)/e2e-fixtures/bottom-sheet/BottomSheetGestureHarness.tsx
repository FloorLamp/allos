"use client";

import { useCallback, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { useConfirm } from "@/components/ConfirmDialog";

export default function BottomSheetGestureHarness({
  guarded,
}: {
  guarded: boolean;
}) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [outcome, setOutcome] = useState<"" | "close" | "gesture">("");

  const close = useCallback(() => {
    setOutcome("close");
    setOpen(false);
  }, []);

  const dismissByGesture = useCallback(() => {
    setOutcome("gesture");
    if (!guarded || !dirty) {
      setOpen(false);
      return;
    }

    void confirm({
      title: "Discard your changes?",
      message: "This test form has an unsaved entry.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    }).then((discard) => {
      if (discard) setOpen(false);
    });
    return false;
  }, [confirm, dirty, guarded]);

  return (
    <main
      className="p-6"
      data-testid="bottom-sheet-gesture-harness"
      data-outcome={outcome}
    >
      <p>Bottom sheet gesture fixture</p>
      <BottomSheet
        open={open}
        onClose={close}
        onGestureDismiss={dismissByGesture}
        title="Gesture contract"
        description="The visible handle enables drag dismissal across this sheet chrome."
        testId="gesture-contract-sheet"
        presentation="dialog"
        showClose
      >
        <form className="space-y-4">
          <label className="block">
            <span>Draft value</span>
            <input
              name="draft"
              className="input mt-1"
              onChange={(event) => setDirty(event.currentTarget.value !== "")}
            />
          </label>
          {Array.from({ length: 36 }, (_, index) => (
            <p key={index} data-testid={`fixture-row-${index + 1}`}>
              Fixture row {index + 1}
            </p>
          ))}
        </form>
      </BottomSheet>
    </main>
  );
}
