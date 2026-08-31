"use client";

import { useCallback, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

// `rows` is the #4334 half: the bottom-edge claim has to hold at ANY content
// height, and the defect it replaced was a padding number that held at exactly
// one. Two rows and forty rows are a short sheet and a sheet at its `85dvh`
// ceiling, and the assertion over them is the same sentence.
export default function BottomSheetGestureHarness({
  guarded,
  rows = 36,
}: {
  guarded: boolean;
  rows?: number;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [notices, setNotices] = useState(0);
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
          {Array.from({ length: rows }, (_, index) => (
            <p key={index} data-testid={`fixture-row-${index + 1}`}>
              Fixture row {index + 1}
            </p>
          ))}
          {/* A notice raised BY a control inside the sheet, which is the #4334
              sequence: the toast the first tap raises must not come to rest on the
              control the next tap is aimed at. KEYED, so one tap or four leaves
              exactly one notice on screen and the band under test never grows. */}
          <button
            type="button"
            data-testid="fixture-raise-notice"
            className="btn"
            onClick={() => {
              setNotices((n) => n + 1);
              toast("Fixture notice.", { key: "bottom-sheet-fixture" });
            }}
          >
            Raise a notice
          </button>
          <p data-testid="fixture-notice-count">{notices}</p>
        </form>
      </BottomSheet>
    </main>
  );
}
