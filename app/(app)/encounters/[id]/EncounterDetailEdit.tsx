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
          {/* Wrapper kept deliberately bare: the dialog host owns the gap under
              the title (`mt-3` in components/BottomSheet.tsx), so this element
              carries no margin of its own (#3361). It stays because removing it
              would make the form the flex item instead of this box. */}
          <div>
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
