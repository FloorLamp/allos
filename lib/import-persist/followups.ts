import {
  adoptBloodTypeFromRecords,
  adoptProfileFromExtraction,
  type ProfileAdoption,
} from "../settings";
import { addCanonicalNames, reconcileFlags } from "../queries";
import type { PersistInput } from "../import-shape";

export interface ImportFollowupOptions {
  demographics: PersistInput["demographics"];
  canonicalNames: string[];
  insertedRecordIds: number[];
  records?: PersistInput["records"];
}

// Best-effort work performed after imported rows have committed. Keeping this out
// of the write transaction ensures a derived-data failure cannot turn a completed
// document back into a failed extraction.
export function applyImportFollowups(
  profileId: number,
  opts: ImportFollowupOptions
): ProfileAdoption {
  const adopted = adoptProfileFromExtraction(profileId, opts.demographics);
  adopted.bloodType = adoptBloodTypeFromRecords(profileId, opts.records);
  if (adopted.bloodType) adopted.changed = true;

  addCanonicalNames(opts.canonicalNames);
  if (adopted.sexAdopted) reconcileFlags(profileId);
  else reconcileFlags(profileId, opts.insertedRecordIds);

  return adopted;
}
