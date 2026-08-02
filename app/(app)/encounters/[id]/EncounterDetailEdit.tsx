"use client";

import { useState } from "react";
import { IconPencil } from "@tabler/icons-react";
import EncounterForm from "../EncounterForm";
import { updateEncounter } from "../actions";
import ModalShell from "@/components/ModalShell";
import type { Encounter } from "@/lib/types";

export default function EncounterDetailEdit({
  encounter,
  profileId,
}: {
  encounter: Encounter;
  profileId: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen(true)}
        data-testid="edit-encounter"
      >
        <IconPencil className="h-4 w-4" stroke={1.75} />
        Edit visit
      </button>
      {open ? (
        <ModalShell title="Edit visit" onClose={() => setOpen(false)}>
          <div className="mt-4">
            <EncounterForm
              action={updateEncounter}
              encounter={encounter}
              profileId={profileId}
              defaultDate={encounter.date}
              onDone={() => setOpen(false)}
              embedded
            />
          </div>
        </ModalShell>
      ) : null}
    </>
  );
}
