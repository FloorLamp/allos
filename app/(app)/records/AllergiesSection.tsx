import Link from "next/link";
import {
  getAllergies,
  getAllergiesView,
  getCrossReactivityNotes,
  getAllergyMedCrossLinks,
  getEncounterPickerOptions,
  getPickerProviders,
  encountersForRecords,
  type LinkedEncounterRef,
} from "@/lib/queries";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import AddEntryPanel from "@/components/AddEntryPanel";
import { EncounterOptionsProvider } from "@/components/EncounterOptionsContext";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import AllergyForm from "@/app/(app)/records/problems/allergies/AllergyForm";
import AllergyList from "@/app/(app)/records/problems/allergies/AllergyList";
import { addAllergy } from "@/app/(app)/records/problems/allergies/actions";

// Allergies (former /allergies index, #1042 phase 6): documented allergies (CCD
// Allergies section + manual) merged with lab-derived allergen-specific IgE
// sensitizations (read-time; RAST / ImmunoCAP), now the #allergies section of
// /records. The merged view leads; the stored rows are managed below.
//
// Multi-view (#1328): the Tier-1 surface is the RECORDED allergies list — it reads the
// whole view-set list-first (readForProfiles preserves each profile's cross-document
// dedup) and gets subject chips + per-item write gates. The lab-DERIVED merged view and
// cross-reactivity cards stay on the ACTING profile (the #1096 scope-limit — a per-
// profile read-time derivation is never evaluated across members). Single view renders
// byte-identical.
export default function AllergiesSection({ scope }: { scope: ProfileScope }) {
  const profileId = scope.actingProfileId;
  const multi = scope.viewIds.length > 1;
  const view = getAllergiesView(profileId);
  // Keep corroborating IgE evidence too: `both` is a documented allergy with a
  // matching positive lab, and splitting the manager from the evidence must not
  // make that lab result disappear from this surface.
  const labSensitizations = view.filter((a) => a.origin !== "documented");
  const stored = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) => getAllergies(pid))
  );
  const crossReactivity = getCrossReactivityNotes(profileId);
  // Bidirectional safety cross-link (#1354): allergyId → the active meds it
  // contraindicates, the SAME drug-allergy findings the /medications safety strip shows,
  // through the SAME dismissal bus. Allergy ids are globally unique, so merging the
  // per-profile maps across the view-set is collision-free (same pattern as the
  // conditions "Treated with" map).
  const contraindications = Object.fromEntries(
    scope.viewIds.flatMap((pid) => Object.entries(getAllergyMedCrossLinks(pid)))
  );
  // "Recorded at: <visit>" (#1526): allergy id → its linked visit, the batch inverse of
  // encounterForRecord. Allergy ids are globally unique, so merging the per-profile maps
  // across the view-set is collision-free (the conditions "Diagnosed at" pattern).
  const recordedAt = Object.fromEntries(
    scope.viewIds.flatMap((pid) =>
      Object.entries(encountersForRecords(pid, "allergy"))
    )
  );
  // The visits each viewed profile's rows may link to. Visits are profile-owned, so a
  // member's row must offer THAT member's visits — one list per profile, never the
  // acting profile's list reused.
  const encountersByProfile: Record<number, readonly LinkedEncounterRef[]> =
    Object.fromEntries(
      scope.viewIds.map((pid) => [pid, getEncounterPickerOptions(pid)])
    );

  return (
    // The add form and every nested per-row edit form read the provider registry and the
    // per-profile visit lists from these two section-level providers (#1176 / #1526), so
    // no list → row → form prop chain has to carry them.
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <EncounterOptionsProvider
        options={{
          actingProfileId: scope.actingProfileId,
          byProfile: encountersByProfile,
        }}
      >
        <div className="space-y-6">
          <AddEntryPanel
            testId="add-allergy-panel"
            panelId="add-allergy-panel-body"
            label="Add allergy"
            presentation="modal"
          >
            <AllergyForm action={addAllergy} />
          </AddEntryPanel>

          <div>
            <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              Recorded allergies
            </h3>
            <AllergyList
              items={stored}
              contraindications={contraindications}
              recordedAt={recordedAt}
              multiView={
                multi ? { actingProfileId: scope.actingProfileId } : undefined
              }
            />
          </div>

          {labSensitizations.length > 0 ? (
            <div className="card">
              <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
                Lab sensitizations
              </h3>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Positive allergen-specific IgE results are evidence of
                sensitization, not by themselves a documented allergy.
              </p>
              <ul className="space-y-3">
                {labSensitizations.map((a) => (
                  <li key={a.key}>
                    <div className="font-medium text-slate-800 dark:text-slate-100">
                      {a.substance}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {a.evidence?.marker}
                      {a.evidence?.value ? ` · ${a.evidence.value}` : ""}
                      {a.evidence?.rastClass != null
                        ? ` · class ${a.evidence.rastClass}`
                        : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {crossReactivity.length > 0 ? (
            <details className="card" data-testid="cross-reactivity">
              <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">
                Cross-reactivity information
              </summary>
              <p className="mb-3 mt-2 text-xs text-slate-500 dark:text-slate-400">
                Informational reference only. A documented cross-reactivity does
                not mean you will react.
              </p>
              <ul className="space-y-3">
                {crossReactivity.map((c) => (
                  <li key={c.familyId} data-testid="cross-reactivity-item">
                    <div className="text-sm text-slate-800 dark:text-slate-100">
                      <span className="font-medium">
                        {c.triggers.join(", ")}
                      </span>{" "}
                      commonly cross-reacts with{" "}
                      <span className="text-slate-600 dark:text-slate-300">
                        {c.related.join(", ")}
                      </span>
                      .
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {c.label} · {c.citation}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Lab sensitizations come from{" "}
            <Link href="/results/biomarkers" className="underline">
              Biomarkers
            </Link>
            ; documented allergies are managed here.
          </p>
        </div>
      </EncounterOptionsProvider>
    </ProviderOptionsProvider>
  );
}
