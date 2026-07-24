import { requireSession } from "@/lib/auth";
import { getUserSex, getUserAge, getUnitPrefs } from "@/lib/settings";
import { getEquipment } from "@/lib/equipment";
import { usesSeniorBattery, VO2_METHODS } from "@/lib/fitness-battery";
import { assembleFitnessCheckModel } from "@/lib/fitness-check-assemble";
import FitnessCheckView from "./FitnessCheckView";

// The guided Fitness check (issue #834). Adult-gated like the rest of the training hub —
// the page's own age gate (isTrainingRestricted) already swaps minors to the sport/cardio
// log, and the norms engine returns null for anyone the percentiles don't cover, so the
// bars simply hide (hide, don't shame — #489). This section gathers the battery for the
// subject's age, the two most recent sessions (for deltas), and the scoring context, then
// hands the ONE pure model to the client.
export default async function FitnessCheckSection() {
  const { login, profile } = await requireSession();
  const sex = getUserSex(profile.id);
  const age = getUserAge(profile.id);
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
