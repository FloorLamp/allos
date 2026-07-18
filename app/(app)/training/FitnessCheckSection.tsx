import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getUserSex,
  getUserAge,
  getUnitPrefs,
} from "@/lib/settings";
import { getLatestBodyMetric } from "@/lib/queries";
import { getEquipment } from "@/lib/equipment";
import {
  batteryForAge,
  usesSeniorBattery,
  VO2_METHODS,
} from "@/lib/fitness-battery";
import {
  getFitnessAssessments,
} from "@/lib/fitness-assessment";
import { getFitnessRetestCadenceDays } from "@/lib/settings";
import { buildFitnessCheckModel } from "@/lib/fitness-check-model";
import FitnessCheckView from "./FitnessCheckView";

// The guided Fitness check (issue #834). Adult-gated like the rest of the training hub —
// the page's own age gate (isTrainingRestricted) already swaps minors to the sport/cardio
// log, and the norms engine returns null for anyone the percentiles don't cover, so the
// bars simply hide (hide, don't shame — #489). This section gathers the battery for the
// subject's age, the two most recent sessions (for deltas), and the scoring context, then
// hands the ONE pure model to the client.
export default async function FitnessCheckSection() {
  const { login, profile } = await requireSession();
  const dateISO = today(profile.id);
  const sex = getUserSex(profile.id);
  const age = getUserAge(profile.id);
  const bodyweightKg = getLatestBodyMetric(profile.id, "weight");
  const weightUnit = getUnitPrefs(login.id).weightUnit;

  const battery = batteryForAge(age);
  const senior = usesSeniorBattery(age);
  const sessions = getFitnessAssessments(profile.id, 12);
  const latest = sessions[0] ?? null;
  const prior = sessions[1] ?? null;
  const model = buildFitnessCheckModel(
    battery,
    latest,
    prior,
    sex,
    age,
    bodyweightKg
  );
  const cadenceDays = getFitnessRetestCadenceDays(profile.id);
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
