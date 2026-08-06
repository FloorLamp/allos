import { getImmunizations } from "@/lib/queries";
import { getUserBirthdate, getUserFullName } from "@/lib/settings";
import {
  buildImmunizationRecord,
  type ImmunizationRecordGroup,
} from "@/lib/immunization-record";

// Server-side gathering for the printable immunization record (issue #1849) — the
// ONE loader the print page and the tokenized /share view both read, so a shared
// record can never disagree with the printed one (the med-list precedent in
// app/(app)/medications/med-data.ts). Reads the SAME profile-scoped, dedup-CTE
// getImmunizations the immunizations surface uses; the pure buildImmunizationRecord
// does the grouping and numbering.

export interface ImmunizationRecordData {
  personName: string;
  birthdate: string | null;
  groups: ImmunizationRecordGroup[];
}

export function getImmunizationRecord(
  profileId: number,
  fallbackName: string
): ImmunizationRecordData {
  return {
    // The full legal name when one is stored — an immunization form is matched
    // against the name on file, not a display nickname.
    personName: getUserFullName(profileId) || fallbackName,
    birthdate: getUserBirthdate(profileId),
    groups: buildImmunizationRecord(getImmunizations(profileId)),
  };
}
