import { requireSession } from "@/lib/auth";
import { getProfileSex, getProfileAge, getUnitPrefs } from "@/lib/settings";
import { getEquipment } from "@/lib/equipment";
import { usesSeniorBattery, VO2_METHODS } from "@/lib/fitness-battery";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";
import { isAdultForClinical } from "@/lib/life-stage";
import FitnessCheckView from "./FitnessCheckView";

// The guided Fitness check (issue #834) uses adult-population norms, so it renders
// only for a known adult even when mounted directly. This section gathers the battery for the
// subject's age, the two most recent sessions (for deltas), and the scoring context, then
// hands the ONE pure model to the client.
export default async function FitnessCheckSection() {
  const { login, profile } = await requireSession();
  const sex = getProfileSex(profile.id);
  const age = getProfileAge(profile.id);
  if (!isAdultForClinical(age)) return null;
  const weightUnit = getUnitPrefs(login.id).weightUnit;
  const senior = usesSeniorBattery(age);

  // The ONE assembler both this section and the save action (post-write outcome +
  // finale) share, so the two never drift (#1307).
  const { model, battery, cadenceDays, dateISO } = assembleFitnessCheckModel(
    profile.id
  );
  const equipmentNames = getEquipment(profile.id).map((e) =>
    e.name.toLowerCase()
  );

  return (
    <FitnessCheckView
      tests={battery}
      model={model}
      vo2Methods={VO2_METHODS.filter((m) => !senior || m.seniorSafe)}
      cadenceDays={cadenceDays}
      weightUnit={weightUnit}
      dateISO={dateISO}
      senior={senior}
      hasSexAndAge={sex != null && age != null}
      equipmentNames={equipmentNames}
    />
  );
}
