"use client";

import { useState } from "react";
import { IconNote, IconX } from "@tabler/icons-react";
import Button from "@/components/Button";
import IconButton from "@/components/IconButton";
import NotesText from "@/components/NotesText";
import SymptomSeverityControl from "@/components/illness/SymptomSeverityControl";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import type { StampedFormData } from "@/lib/logged-via";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useToast } from "@/components/Toast";
import { UNDO_TOAST_MS } from "@/components/useUndoableDelete";
import { undoDelete } from "@/app/(app)/undo-actions";
import {
  logSymptom,
  lowerSymptom,
  setSymptomNote,
  removeSymptom,
} from "@/app/(app)/symptom-actions";

// THE SYMPTOM DOMAIN'S ONE ROW CONTROL (#4424 ruling 3), named by
// `LOG_MANIFEST.symptom.pieces.rowControl`: everything a logged symptom-day's row can
// be corrected with WITHOUT restating it — the severity taps, the note, and the clear
// with its undo. It used to live inside `SymptomLogBar`, which meant those four writes,
// their optimism and the undo contract were reachable only by mounting the whole bar.
//
// A FULL-STATEMENT EDIT IS THE FORM'S, NOT THIS CONTROL'S. `SymptomForm` in edit mode
// restates the day; this restates nothing — each tap moves one field.
//
// RAISE AND LOWER ARE DIFFERENT ACTIONS ON PURPOSE (#857). A plain tap can only ever
// RAISE (the day keeps its worst severity, server-enforced), so selecting a labelled
// chip BELOW the current value posts the narrow `lowerSymptom` instead. Sufficient
// intent, no confirm: the chip says which level it is.
//
// THE HOST OWNS THE ROW SET, THIS OWNS THE WRITES. `severity` and `note` are the host's
// state because it decides which rows are logged at all — a cleared row leaves the
// list — so this control reports every optimistic and settled value up rather than
// keeping a second copy that could disagree with the list it is rendered in.
export default function SymptomRowControl({
  symptom,
  label,
  date,
  severity,
  note,
  subjectProfileId,
  episodeId,
  onSeverity,
  onNote,
}: {
  symptom: string;
  /** How this row prints — the accessible names and the undo toast use it. */
  label: string;
  /** The day this row is on. Its other half of the address (#799). */
  date: string;
  severity: number;
  note: string;
  subjectProfileId?: number;
  episodeId?: number;
  onSeverity: (value: number) => void;
  onNote: (value: string) => void;
}) {
  const toast = useToast();
  const stampLoggedVia = useLoggedViaStamp();
  const ledger = useOptimisticLedger<number>("symptom-severity");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Every write this control makes names the same row and the same subject.
  const post = (): StampedFormData => {
    const fd = new FormData();
    fd.set("symptom", symptom);
    fd.set("date", date);
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    if (episodeId != null) fd.set("episodeId", String(episodeId));
    // WHICH SURFACE (#3087): one control on the dashboard, the Timeline, the Cycles
    // page and the illness cockpit's panels, so the mounting declares itself.
    return stampLoggedVia(fd);
  };

  async function move(next: number): Promise<void> {
    const lowering = next < severity;
    await ledger.tap({
      // Keyed on the TRANSITION, like the dose control's: a row's chips all write the
      // same day's severity, so "the same write twice" is prev→next, not the chip.
      // Two taps of one chip share a key and the second is absorbed; every deliberate
      // move — raise, then lower back to where it started — is a different transition
      // and always lands.
      key: `${symptom}:${severity}->${next}`,
      from: severity,
      optimistic: lowering ? next : Math.max(severity, next),
      commit: onSeverity,
      write: () => {
        const fd = post();
        fd.set("severity", String(next));
        return lowering ? lowerSymptom(fd) : logSymptom(fd);
      },
      settle: (res) => {
        if (res.ok) return { kind: "adopt", value: res.severity };
        toast(res.error || "Couldn't log that symptom — try again.", {
          tone: "error",
        });
        return { kind: "rollback" };
      },
      onError: () => {
        toast("Couldn't log that symptom — try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  async function saveNote(value: string): Promise<void> {
    const prev = note;
    onNote(value);
    setEditing(false);
    const fd = post();
    fd.set("note", value);
    const res = await setSymptomNote(fd);
    if (!res.ok) {
      onNote(prev);
      toast(res.error || "Couldn't save that note.", { tone: "error" });
    }
  }

  // The × is a one-tap delete that used to reach OFF-DB — it unlinked the day's photo
  // FILES — with no confirm and nothing to take it back (#2124). It stays one tap,
  // deliberately: for a symptom chip a confirm on every clear is the wrong tax, and
  // undo-after-the-fact is the calmer contract. So the capture the action returns gets
  // a toast whose Undo restores the row, its photo rows and their files, and puts the
  // chip back where it was.
  //
  // No token means nothing was deleted (the day was already clear) — a plain
  // confirmation then, never an Undo that would restore nothing.
  function offerUndo(
    undoId: number | null,
    prevSeverity: number,
    prevNote: string
  ): void {
    if (undoId == null) return;
    toast("Symptom removed.", {
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            const { ok } = await undoDelete(undoId);
            if (!ok) {
              toast("Couldn’t undo — it may have expired.", { tone: "error" });
              return;
            }
            // Put the chip back at the severity the row was restored with, and its
            // note with it — the restore re-inserted the captured row verbatim, so the
            // local state that named it is exactly right again.
            onSeverity(prevSeverity);
            if (prevNote) onNote(prevNote);
            toast("Restored.");
          })();
        },
      },
    });
  }

  async function clear(): Promise<void> {
    const prev = severity;
    const prevNote = note;
    onNote("");
    setEditing(false);
    await ledger.tap({
      key: `${symptom}:${prev}->clear`,
      from: prev,
      optimistic: 0,
      commit: onSeverity,
      write: () => removeSymptom(post()),
      settle: (res) => {
        // The × has no authoritative number to adopt — the row is gone — so the
        // optimistic zero stands and only a refusal puts the day back.
        if (res.ok) {
          offerUndo(res.undoId ?? null, prev, prevNote);
          return { kind: "keep" };
        }
        if (prevNote) onNote(prevNote);
        toast(res.error || "Couldn't remove that symptom.", { tone: "error" });
        return { kind: "rollback" };
      },
      onError: () => {
        if (prevNote) onNote(prevNote);
        toast("Couldn't remove that symptom.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  return (
    <>
      {/* `gap-3` is the reach floor (#3938). */}
      <div className="flex flex-wrap items-center gap-3">
        <SymptomSeverityControl
          symptomLabel={label}
          value={severity}
          testIdPrefix={`symptom-${symptom}-sev`}
          onChange={(next) => void move(next)}
        />
        <IconButton
          type="button"
          data-testid={`symptom-${symptom}-note-toggle`}
          label={`${note ? "Edit" : "Add"} note for ${label}`}
          pressed={editing}
          tone={note ? "brand" : "neutral"}
          onClick={() => {
            if (editing) setEditing(false);
            else {
              setDraft(note);
              setEditing(true);
            }
          }}
        >
          <IconNote className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          type="button"
          data-testid={`symptom-${symptom}-clear`}
          label={`Clear ${label}`}
          disabled={severity <= 0}
          onClick={() => void clear()}
        >
          <IconX className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      {editing && (
        <form
          className="mt-1 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveNote(draft);
          }}
        >
          <input
            data-testid={`symptom-${symptom}-note-input`}
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== note) void saveNote(draft);
              else setEditing(false);
            }}
            placeholder="Note (e.g. worse at night)…"
            maxLength={500}
            className="input flex-1 text-sm"
          />
          <Button type="submit" data-testid={`symptom-${symptom}-note-save`}>
            Save
          </Button>
        </form>
      )}

      {!editing && note && (
        <NotesText
          data-testid={`symptom-${symptom}-note`}
          as="p"
          notes={note}
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
        />
      )}
    </>
  );
}
