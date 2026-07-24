// The ONE DB-side assembler for the Fitness-check model (#834/#1307). Both the page
// section (FitnessCheckSection) and the save action (which rebuilds the model AFTER a
// write to compute the per-test outcome + battery-completion finale) gather the same
// inputs — battery for age, recent sessions, ambient natural-store readings, the scoring
// context, and the equipment-missing set — through this one helper, so the two can never
// drift ("one question, one computation"). AUTH-BLIND + profileId-first (no lib/auth); the
// pure model math stays in lib/fitness-check-model.
//
// The profile's WEIGHT-unit display preference is login-scoped, so it is NOT resolved here
// (the section reads it separately for the view); the model itself is unit-agnostic
// (canonical storage), so nothing here needs it.

import { today } from "./db";
import {
  getUserSex,
  getUserAge,
  getFitnessRetestCadenceDays,
} from "./settings";
import { getLatestBodyMetric } from "./queries";
import { getEquipment } from "./equipment";
import {
  batteryForAge,
  equipmentMissingTestKeys,
  type FitnessTestDef,
} from "./fitness-battery";
import {
  getFitnessAssessments,
  getAmbientFitnessReadings,
} from "./fitness-assessment";
import {
  buildFitnessCheckModel,
  type FitnessCheckModel,
} from "./fitness-check-model";

export interface AssembledFitnessCheck {
  model: FitnessCheckModel;
  battery: FitnessTestDef[];
  cadenceDays: number;
  // Battery test keys the profile lacks equipment for — held out of the completion
  // denominator (#1307). Shared by the completion decision + the tile "no equipment" hint.
  equipmentMissingKeys: Set<string>;
  dateISO: string;
}

export function assembleFitnessCheckModel(
  profileId: number
): AssembledFitnessCheck {
  const dateISO = today(profileId);
  const sex = getUserSex(profileId);
  const age = getUserAge(profileId);
  const bodyweightKg = getLatestBodyMetric(profileId, "weight");
  const battery = batteryForAge(age);
  const sessions = getFitnessAssessments(profileId, 12);
  const ambient = getAmbientFitnessReadings(profileId, battery);
  const cadenceDays = getFitnessRetestCadenceDays(profileId);
  const model = buildFitnessCheckModel(
    battery,
    sessions,
    ambient,
    sex,
    age,
    bodyweightKg,
    dateISO,
    cadenceDays
  );
  const equipmentNames = getEquipment(profileId).map((e) =>
    e.name.toLowerCase()
  );
  return {
    model,
    battery,
    cadenceDays,
    equipmentMissingKeys: equipmentMissingTestKeys(battery, equipmentNames),
    dateISO,
  };
}
