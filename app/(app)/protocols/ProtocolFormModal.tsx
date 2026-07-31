"use client";

import { useState } from "react";
import ModalShell from "@/components/ModalShell";
import ProtocolForm, {
  PROTOCOL_MODAL_CLASS,
  type ProtocolFormProps,
} from "./ProtocolForm";

type CreateProtocolFormProps = Omit<
  ProtocolFormProps,
  "onDone" | "practice" | "protocol"
>;

// The creation entry point for the shared protocol form. The form used to expand
// inside Longevity's narrow list rail; keeping only the trigger inline gives the
// outcome picker and intervention fields the width of a real work surface.
export default function ProtocolFormModal(props: CreateProtocolFormProps) {
  const [open, setOpen] = useState(props.template != null);

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen(true)}
        data-testid="new-protocol-toggle"
      >
        + New protocol
      </button>
      {open && (
        <ModalShell
          title="New protocol"
          onClose={() => setOpen(false)}
          className={PROTOCOL_MODAL_CLASS}
        >
          <ProtocolForm {...props} onDone={() => setOpen(false)} />
        </ModalShell>
      )}
    </>
  );
}
