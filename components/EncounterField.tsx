"use client";

import { formatVisitLabel } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useEncounterOptions } from "@/components/EncounterOptionsContext";
import type { LinkedEncounterRef } from "@/lib/queries";

// The shared "which visit was this recorded at?" form field (issue #1526): a labelled
// <select> over the profile's visits, read from EncounterOptionsContext. A <select>, not
// a combobox, because unlike a provider a visit is never created on the fly — you link
// an existing one — so free text would only ever be a near-miss. The write path
// re-validates the posted id against the profile regardless (encounterIdForProfile).
//
// WHY a picker at all, when the #1050 suggest-and-accept flow exists: that flow needs an
// EXACT date match between the row and a visit, and neither of these two domains reliably
// has one. An allergy's only date is `onset_date` — when the reaction began, not when a
// clinician documented it — and a lesion is often photographed at home days before the
// dermatologist sees it. So for these two the manual pick is the primary path and the
// same-day suggestion is the bonus, the inverse of procedures/imaging.
//
// Option text runs through formatVisitLabel, the SAME computation RecordEncounterLink
// renders, so what you pick is what you read back on the row. The empty option means "no
// link", which is also how an existing link is cleared.
//
// ABSENT PILLAR: a profile with no recorded visits gets no field at all — a select whose
// only choice is "none" asks a question that has no answer yet.
export default function EncounterField({
  uid,
  label = "Recorded at visit",
  defaultValue,
  profileId,
  encounters,
  testid,
}: {
  // Disambiguates the id/label pair across the add form and the per-row edit forms
  // rendered on the same page (the `record?.id ?? "new"` convention).
  uid: string | number;
  label?: string;
  defaultValue?: number | null;
  // The ROW's own profile in a multi-view list, so a member's allergy offers that
  // member's visits. Undefined on a single-view surface (the acting profile).
  profileId?: number;
  // Defaults to the section-level EncounterOptionsContext; an explicit list is for
  // callers outside a provider (and for tests).
  encounters?: readonly LinkedEncounterRef[];
  testid?: string;
}) {
  const fmt = useFormatPrefs();
  const fromContext = useEncounterOptions(profileId);
  const rows = encounters ?? fromContext;
  if (rows.length === 0) return null;
  const fieldId = `encounter-link-${uid}`;
  return (
    <div>
      <label className="label" htmlFor={fieldId}>
        {label}
      </label>
      <select
        id={fieldId}
        name="encounter_id"
        className="input"
        data-testid={testid}
        defaultValue={defaultValue == null ? "" : String(defaultValue)}
      >
        <option value="">Not linked to a visit</option>
        {rows.map((e) => (
          <option key={e.id} value={e.id}>
            {formatVisitLabel(e, fmt)}
          </option>
        ))}
      </select>
    </div>
  );
}
