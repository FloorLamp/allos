"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SubmitButton from "@/components/SubmitButton";
import ModalShell from "@/components/ModalShell";
import DateField from "@/components/DateField";
import { editEpisodeAction } from "@/app/(app)/medical/episodes/actions";

// Episode boundary + annotation editor (issue #856 items 1/8/9). A plain row edit —
// derived membership follows the new [start, end) automatically (no change-log surgery).
// An OPEN episode edits only its start (the "flagged a day late" fix); its end is owned
// by the "Feeling better" toggle, so the field is hidden. A closed episode edits both.
// Dates use the internal semantics directly: start = first day sick, end = first day
// better (EXCLUSIVE), which is exactly how the toggle stamps them.
export default function EpisodeEditor({
  episodeId,
  ongoing,
  startedAt,
  endedAt,
  note,
  outcome,
  profileId,
  open,
  onClose,
}: {
  episodeId: number;
  ongoing: boolean;
  startedAt: string | null;
  endedAt: string | null;
  note: string | null;
  outcome: string | null;
  // The cross-profile write target (issue #879) — set on a household member's episode page
  // so editEpisodeAction gates on THAT profile (requireProfileWriteAccess). Absent on the
  // acting profile's own page.
  profileId?: number;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(fd: FormData) {
    setError(null);
    const res = await editEpisodeAction(fd);
    if (res.ok) {
      onClose();
      router.refresh();
    } else {
      setError(res.error);
    }
  }

  if (!open) return null;

  return (
    <ModalShell title="Edit episode" onClose={onClose}>
      <form
        action={onSubmit}
        className="flex flex-col gap-4"
        data-testid="episode-editor"
      >
        <input type="hidden" name="episodeId" value={episodeId} />
        {profileId != null && (
          <input type="hidden" name="profileId" value={profileId} />
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="ep-start">
              First day sick
            </label>
            <DateField
              id="ep-start"
              name="startedAt"
              defaultValue={startedAt ?? ""}
              data-testid="episode-start-input"
            />
          </div>
          {!ongoing && (
            <div>
              <label className="label" htmlFor="ep-end">
                First day better
              </label>
              <DateField
                id="ep-end"
                name="endedAt"
                defaultValue={endedAt ?? ""}
                data-testid="episode-end-input"
              />
            </div>
          )}
        </div>
        <div>
          <label className="label" htmlFor="ep-outcome">
            Outcome
          </label>
          <input
            id="ep-outcome"
            name="outcome"
            type="text"
            defaultValue={outcome ?? ""}
            placeholder="e.g. self-resolved, saw pediatrician"
            className="input"
            data-testid="episode-outcome-input"
          />
        </div>
        <div>
          <label className="label" htmlFor="ep-note">
            Note
          </label>
          <textarea
            id="ep-note"
            name="note"
            defaultValue={note ?? ""}
            rows={3}
            placeholder="pediatrician said…"
            className="input"
            data-testid="episode-note-input"
          />
        </div>
        {error && (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        )}
        <div className="flex gap-2">
          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
