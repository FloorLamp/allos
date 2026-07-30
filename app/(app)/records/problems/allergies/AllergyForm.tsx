"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import ProviderCombobox from "@/components/ProviderCombobox";
import EncounterField from "@/components/EncounterField";
import { useToast } from "@/components/Toast";
import {
  ALLERGY_CRITICALITIES,
  ALLERGY_VERIFICATION_STATUSES,
  type Allergy,
  type FormResult,
} from "@/lib/types";
import { composeAllergyReactions } from "@/lib/allergy-reactions";

// Labels for the two CHECK-pinned safety vocabularies (#1405). "Not stated" is the
// default option in both — an unstated criticality is not "low", and an unstated
// verification is not "confirmed".
const CRITICALITY_OPTIONS: Record<
  (typeof ALLERGY_CRITICALITIES)[number],
  string
> = {
  low: "Low — unlikely to be life-threatening",
  high: "High — could be life-threatening",
  "unable-to-assess": "Not assessable",
};

const VERIFICATION_OPTIONS: Record<
  (typeof ALLERGY_VERIFICATION_STATUSES)[number],
  string
> = {
  unconfirmed: "Unconfirmed",
  suspected: "Suspected",
  confirmed: "Confirmed",
  refuted: "Refuted — ruled out",
  "entered-in-error": "Entered in error",
};

// A blank manifestation row.
const EMPTY_ROW = { manifestation: "", severity: "" };

// Shared add/edit allergy form. Add mode: no `allergy`. Edit mode: pass the row +
// an `onDone` callback (renders a hidden id and a Cancel button).
export default function AllergyForm({
  action,
  allergy,
  profileId,
  onDone,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  allergy?: Allergy;
  // Multi-view (#1328): the row's OWN profile, posted so an edit on a non-acting
  // member's row targets that member (gateItemProfile). Undefined in single view.
  profileId?: number;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!allergy;
  const [error, setError] = useState<string | null>(null);
  // Repeatable manifestation rows (#1405): a peanut allergy that causes BOTH hives
  // AND anaphylaxis is two graded rows, not one string. Seeded through the SAME pure
  // composition every read surface uses, so an imported row whose reactions live
  // only in the parent's cached scalar edits as one row here.
  const [reactions, setReactions] = useState(() => {
    // `allergy.reactions` is already the composed list (getAllergies attaches it);
    // fall back to the parent's cached scalar for any caller that passes a raw row.
    const seeded = composeAllergyReactions(
      allergy ?? { reaction: null, severity: null },
      (allergy?.reactions ?? []).map((r, i) => ({ ...r, position: i }))
    ).map((r) => ({
      manifestation: r.manifestation,
      severity: r.severity ?? "",
    }));
    return seeded.length > 0 ? seeded : [{ ...EMPTY_ROW }];
  });

  async function handle(formData: FormData) {
    setError(null);
    if (!String(formData.get("substance") ?? "").trim()) {
      setError("Enter the substance you're allergic to.");
      return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this allergy. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editing ? "Allergy updated" : "Allergy saved");
    if (!editing) {
      formRef.current?.reset();
      setReactions([{ ...EMPTY_ROW }]);
    }
    onDone?.();
    router.refresh();
  }

  const uid = allergy?.id ?? "new";
  return (
    <form ref={formRef} action={handle} className="card space-y-3">
      {!editing && (
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Add allergy
        </h2>
      )}
      {editing && <input type="hidden" name="id" value={allergy!.id} />}
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      <div>
        <label className="label" htmlFor={`allergy-substance-${uid}`}>
          Substance
        </label>
        <input
          id={`allergy-substance-${uid}`}
          name="substance"
          className="input"
          defaultValue={allergy?.substance ?? ""}
          placeholder="e.g. Penicillin, Peanut, Latex"
          required
        />
      </div>
      <fieldset className="space-y-2" data-testid={`allergy-reactions-${uid}`}>
        <legend className="label">Reactions</legend>
        {reactions.map((r, i) => (
          <div className="grid grid-cols-2 gap-3" key={i}>
            <input
              name="reaction_manifestation"
              className="input"
              aria-label={`Reaction ${i + 1}`}
              data-testid={`allergy-reaction-${uid}-${i}`}
              value={r.manifestation}
              onChange={(e) =>
                setReactions((rows) =>
                  rows.map((row, j) =>
                    j === i ? { ...row, manifestation: e.target.value } : row
                  )
                )
              }
              placeholder="e.g. Hives, Anaphylaxis"
            />
            <div className="flex gap-2">
              <input
                name="reaction_severity"
                className="input"
                aria-label={`Severity ${i + 1}`}
                data-testid={`allergy-severity-${uid}-${i}`}
                value={r.severity}
                onChange={(e) =>
                  setReactions((rows) =>
                    rows.map((row, j) =>
                      j === i ? { ...row, severity: e.target.value } : row
                    )
                  )
                }
                placeholder="e.g. Moderate"
              />
              {reactions.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost px-2 text-xs"
                  aria-label={`Remove reaction ${i + 1}`}
                  onClick={() =>
                    setReactions((rows) => rows.filter((_, j) => j !== i))
                  }
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost text-xs"
          data-testid={`allergy-add-reaction-${uid}`}
          onClick={() => setReactions((rows) => [...rows, { ...EMPTY_ROW }])}
        >
          Add reaction
        </button>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`allergy-criticality-${uid}`}>
            Criticality
          </label>
          <select
            id={`allergy-criticality-${uid}`}
            name="criticality"
            className="input"
            defaultValue={allergy?.criticality ?? ""}
          >
            <option value="">Not stated</option>
            {ALLERGY_CRITICALITIES.map((c) => (
              <option key={c} value={c}>
                {CRITICALITY_OPTIONS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`allergy-verification-${uid}`}>
            Verification
          </label>
          <select
            id={`allergy-verification-${uid}`}
            name="verification_status"
            className="input"
            defaultValue={allergy?.verification_status ?? ""}
          >
            <option value="">Not stated</option>
            {ALLERGY_VERIFICATION_STATUSES.map((v) => (
              <option key={v} value={v}>
                {VERIFICATION_OPTIONS[v]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        A refuted allergy stays on record but stops gating your medications and
        drops off the emergency card.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`allergy-status-${uid}`}>
            Status
          </label>
          <select
            id={`allergy-status-${uid}`}
            name="status"
            className="input"
            defaultValue={allergy?.status ?? "active"}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`allergy-onset-${uid}`}>
            Onset date
          </label>
          <DateField
            id={`allergy-onset-${uid}`}
            name="onset_date"
            defaultValue={allergy?.onset_date ?? ""}
          />
        </div>
      </div>
      {/* Attribution (#1526): who documented this allergy, and at which visit. An
          allergy gates drug warnings and prints on the emergency card, so "who confirmed
          it" is the natural companion to the verification status above. */}
      <div>
        <label className="label" htmlFor={`allergy-provider-${uid}`}>
          Documented by
        </label>
        {/* Create-on-type from the shared registry (ProviderCombobox, #1176). */}
        <ProviderCombobox
          id={`allergy-provider-${uid}`}
          name="provider"
          defaultValue={allergy?.provider_name ?? ""}
          placeholder="e.g. Dr. Okafor"
        />
        {editing && (
          <>
            <input
              type="hidden"
              name="provider_id"
              value={allergy?.provider_id ?? ""}
            />
            <input
              type="hidden"
              name="provider_loaded"
              value={allergy?.provider_name ?? ""}
            />
          </>
        )}
      </div>
      <EncounterField
        uid={uid}
        label="Recorded at visit"
        defaultValue={allergy?.encounter_id ?? null}
        profileId={profileId}
        testid={`allergy-encounter-${uid}`}
      />
      <div>
        <label className="label" htmlFor={`allergy-notes-${uid}`}>
          Notes
        </label>
        <input
          id={`allergy-notes-${uid}`}
          name="notes"
          className="input"
          defaultValue={allergy?.notes ?? ""}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <SubmitButton className="btn w-full" pendingLabel="Saving…">
          {editing ? "Save" : "Add"}
        </SubmitButton>
        {editing && onDone && (
          <button type="button" className="btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
