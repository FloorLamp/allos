"use client";

import { useState } from "react";
import ModalShell from "@/components/ModalShell";
import ProtocolForm, { type ProtocolFormProps } from "./ProtocolForm";
import { useCreateActionLabel } from "@/components/CreateAction";

type CreateProtocolFormProps = Omit<
  ProtocolFormProps,
  "onDone" | "practice" | "protocol"
>;

// The creation entry point for the shared protocol form. The form used to expand
// inside Longevity's narrow list rail; keeping only the trigger inline gives the
// outcome picker and intervention fields the width of a real work surface.
export default function ProtocolFormModal(props: CreateProtocolFormProps) {
  const [open, setOpen] = useState(props.template != null);
  const label = useCreateActionLabel();

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen(true)}
        data-testid="new-protocol-toggle"
      >
        {label}
      </button>
      {open && (
        <ModalShell title={label} onClose={() => setOpen(false)} size="md">
          <ProtocolForm {...props} onDone={() => setOpen(false)} />
        </ModalShell>
      )}
    </>
  );
}
