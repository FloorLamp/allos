import { db, today, writeTx } from "../db";
import { ageFromBirthdate, ageMonthsFrom } from "../date";
import type { Sex, ReproductiveStatus } from "../types";
import {
  bloodGroupPartsFromReadings,
  normalizeAbo,
  normalizeRh,
  resolveBloodType,
  type BloodGroupParts,
  type BloodGroupReading,
} from "../profile-summary";
import {
  parsePackYears,
  parseQuitYear,
  parseSmokingStatus,
  type SmokingHistory,
} from "../smoking";
import {
  diffSituations,
  parseSituationEvents,
  serializeSituationEvents,
  type SituationEvent,
} from "../trend-annotations";
import {
  normalizeSituationName,
  isBuiltInIllnessSituation,
} from "../situations";
import { syncOpenIllnessEpisode } from "../illness-episode-store";
import { DEFAULT_FITNESS_RETEST_DAYS } from "../fitness-retest";
import { zipToHome } from "../home-location";
import { getHomeLocation, setHomeLocation } from "./location";
import {
  METRIC_SOURCE_PRIORITY_KEY,
  isValidSourceId,
  parseMetricSourcePriority,
  serializeMetricSourcePriority,
  withMetricSource,
  type MetricSourcePriority,
} from "../metric-source-priority";
import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
} from "./kv";

// The profile's biological sex, used to pick sex-specific optimal biomarker
// bands. Null when unset — callers then fall back to the generic optimal range.
export function getUserSex(profileId: number): Sex | null {
  const v = getProfileSetting(profileId, "sex");
  return v === "male" ? "male" : v === "female" ? "female" : null;
}

export function setUserSex(profileId: number, sex: Sex | null) {
  if (sex === null) {
    deleteProfileSetting(profileId, "sex");
    return;
  }
  setProfileSetting(profileId, "sex", sex);
}

// The profile's reproductive (menopausal) status — a CURRENT attribute of the
// tracked person, mirroring getUserSex/setUserSex. Used to pick life-stage-aware
// reference ranges for the female reproductive hormones (Estradiol/FSH/LH): when
// set (and the sex is female) it overrides the age proxy so a genuinely
// post-menopausal high hormone flags. Null when unset (not specified) — then the
// age-proxy fallback (e.g. the FSH 51+ band) applies, unchanged. Applies to female
// physiology only; a male profile's ranges are unaffected regardless of this value.
export function getUserReproductiveStatus(
  profileId: number
): ReproductiveStatus | null {
  const v = getProfileSetting(profileId, "reproductive_status");
  return v === "premenopausal"
    ? "premenopausal"
    : v === "postmenopausal"
      ? "postmenopausal"
      : null;
}

export function setUserReproductiveStatus(
  profileId: number,
  status: ReproductiveStatus | null
) {
  if (status === null) {
    deleteProfileSetting(profileId, "reproductive_status");
    return;
  }
  setProfileSetting(profileId, "reproductive_status", status);
}

// ---- Smoking history (issue #83) ----
// A per-profile STRUCTURED smoking record — status (never | former | current;
// absent = unknown, the tri-state the risk-gated screening rules need), pack-years,
// and the quit year — stored as discrete profile_settings keys like sex/birthdate.
// A `smoking_source` key records provenance ('manual' | 'imported') so a CCD
// re-import (adoptSmokingStatusFromImport) never clobbers a user's correction. This
// content is more sensitive than most profile_settings and, like the rest of the
// passport, is visible to any login granted the profile — the UI states that.
export function getSmokingHistory(profileId: number): SmokingHistory {
  return {
    status: parseSmokingStatus(getProfileSetting(profileId, "smoking_status")),
    packYears: parsePackYears(
      getProfileSetting(profileId, "smoking_pack_years")
    ),
    quitYear: parseQuitYear(getProfileSetting(profileId, "smoking_quit_year")),
  };
}

// Persist the structured smoking record. Manual entry is AUTHORITATIVE: it marks
// the source 'manual' so a later import leaves it alone. status null clears the
// whole record. pack-years applies only to an ever-smoker (former/current) and the
// quit year only to a former smoker; a 'never'/unset status drops both so a stale
// quantity can't linger and mislead the gate.
export function setSmokingHistory(
  profileId: number,
  record: SmokingHistory,
  source: "manual" | "imported" = "manual"
): void {
  writeTx(() => {
    if (record.status == null) {
      deleteProfileSetting(profileId, "smoking_status");
      deleteProfileSetting(profileId, "smoking_pack_years");
      deleteProfileSetting(profileId, "smoking_quit_year");
      deleteProfileSetting(profileId, "smoking_source");
      return;
    }
    setProfileSetting(profileId, "smoking_status", record.status);
    if (record.status !== "never" && record.packYears != null) {
      setProfileSetting(
        profileId,
        "smoking_pack_years",
        String(record.packYears)
      );
    } else {
      deleteProfileSetting(profileId, "smoking_pack_years");
    }
    if (record.status === "former" && record.quitYear != null) {
      setProfileSetting(
        profileId,
        "smoking_quit_year",
        String(record.quitYear)
      );
    } else {
      deleteProfileSetting(profileId, "smoking_quit_year");
    }
    setProfileSetting(profileId, "smoking_source", source);
  });
}

// Seed the structured smoking STATUS from an imported CCD social-history smoking
// condition (issue #83) so the risk-gated screening rules read structured data and
// the two representations don't drift. Respects a manual entry: when the record was
// last set by the user (source 'manual') the import leaves it untouched — a wrong
// import can't overwrite a correction. Otherwise it (re)seeds the status
// (latest-import-wins, mirroring the condition row) WITHOUT touching pack-years (a
// CCD rarely carries them), clearing a now-stale quit year only when the new status
// is 'current'.
export function adoptSmokingStatusFromImport(
  profileId: number,
  status: "former" | "current"
): void {
  if (getProfileSetting(profileId, "smoking_source") === "manual") return;
  writeTx(() => {
    setProfileSetting(profileId, "smoking_status", status);
    if (status === "current") {
      deleteProfileSetting(profileId, "smoking_quit_year");
    }
    setProfileSetting(profileId, "smoking_source", "imported");
  });
}

// The tracked person's full/legal name — distinct from profiles.name, which is
// the short display label ("Me", "Mom") shown in the switcher. Lives in
// profile_settings like the other per-person facts (sex, birthdate); used where a
// real name matters (e.g. a medical-summary handout) and backfilled from imported
// records. Null when unset.
export function getUserFullName(profileId: number): string | null {
  const v = getProfileSetting(profileId, "full_name");
  return v && v.trim() ? v : null;
}

export function setUserFullName(profileId: number, name: string | null) {
  const v = name?.trim();
  if (!v) {
    deleteProfileSetting(profileId, "full_name");
    return;
  }
  setProfileSetting(profileId, "full_name", v.slice(0, 200));
}

// The profile's birthdate (ISO YYYY-MM-DD), when known. A property of the tracked
// person, so it lives in profile_settings. Preferred over a bare age because the
// current age can be derived from it at any time (see getUserAge).
export function getUserBirthdate(profileId: number): string | null {
  return getProfileSetting(profileId, "birthdate") ?? null;
}

// Set (or clear, with null) the profile's birthdate. Setting a real date also
// drops any stored age fallback: once the birthdate is known, a bare age is
// redundant (and would otherwise linger as stale data). Keeps the invariant
// that the 'age' key exists only while no birthdate is set.
export function setUserBirthdate(profileId: number, date: string | null) {
  if (!date) {
    deleteProfileSetting(profileId, "birthdate");
    return;
  }
  writeTx(() => {
    setProfileSetting(profileId, "birthdate", date);
    deleteProfileSetting(profileId, "age");
  });
}

// A stored age fallback (whole years) for the profile, used only when no birthdate
// is known — e.g. a document states an age but no date of birth. A birthdate always
// wins.
export function getStoredAge(profileId: number): number | null {
  const v = getProfileSetting(profileId, "age");
  const n = v != null ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 && n < 150 ? n : null;
}

export function setStoredAge(profileId: number, age: number | null) {
  if (age === null) {
    deleteProfileSetting(profileId, "age");
    return;
  }
  setProfileSetting(profileId, "age", String(Math.round(age)));
}

// The profile's age in MONTHS for the schedule engines (issue #310): the
// canonical policy — birthdate wins (exact calendar month math), else the stored
// whole-year age × 12, else null (unknown). Shared by the immunization and
// preventive-care assessments (via Upcoming) and the dashboard/immunization
// pages so every surface agrees which vaccines are due. The month-resolution
// math is the pure ageMonthsFrom() in lib/date.ts; this wrapper adds the
// profile-scoped reads (getUserBirthdate/getStoredAge filter profile_id).
export function profileAgeMonths(profileId: number, on: string): number | null {
  return ageMonthsFrom(
    getUserBirthdate(profileId),
    getStoredAge(profileId),
    on
  );
}

// The profile's current age in whole years: derived from the birthdate when set,
// otherwise the stored age fallback. Null when neither is known. The profile id
// also resolves "today" in that profile's timezone.
export function getUserAge(profileId: number): number | null {
  const bd = getUserBirthdate(profileId);
  if (bd) return ageFromBirthdate(bd, today(profileId));
  return getStoredAge(profileId);
}

// The profile's age (whole years) as of a specific date, for age-banded biomarker
// ranges: derived from the birthdate on that date (the "age on the collection
// date, not today" rule), else the stored age fallback, else null. Used by the
// biomarker UI to pick the band that applied to a given reading.
export function getUserAgeOn(
  profileId: number,
  on: string | null | undefined
): number | null {
  const bd = getUserBirthdate(profileId);
  if (bd && on) {
    const a = ageFromBirthdate(bd, on);
    if (a != null) return a;
  }
  return getStoredAge(profileId);
}

// ---- Health risk factors (issue #517) — profile scope, no migration ----
// Self-declared occupational / immune-status context the risk-stratification
// layer needs but that isn't captured by the clinical conditions/family-history
// tables: healthcare worker (occupational hepatitis exposure), immunocompromised,
// on dialysis, pregnant. Each is a discrete "1"/absent profile_settings flag like
// the emergency-card toggle. Sensitive like the rest of the passport — visible to
// any login granted the profile. Informational only; drives cadence/priority, not
// diagnosis.
import type { RiskAttributes } from "../risk-stratification";
import { EMPTY_RISK_ATTRIBUTES } from "../risk-stratification";

const RISK_ATTR_KEYS: Record<keyof RiskAttributes, string> = {
  healthcareWorker: "risk_healthcare_worker",
  immunocompromised: "risk_immunocompromised",
  dialysis: "risk_dialysis",
  pregnant: "risk_pregnant",
};

export function getRiskAttributes(profileId: number): RiskAttributes {
  const read = (key: string) => getProfileSetting(profileId, key) === "1";
  return {
    healthcareWorker: read(RISK_ATTR_KEYS.healthcareWorker),
    immunocompromised: read(RISK_ATTR_KEYS.immunocompromised),
    dialysis: read(RISK_ATTR_KEYS.dialysis),
    pregnant: read(RISK_ATTR_KEYS.pregnant),
  };
}

export function setRiskAttributes(
  profileId: number,
  attrs: RiskAttributes
): void {
  writeTx(() => {
    (Object.keys(RISK_ATTR_KEYS) as (keyof RiskAttributes)[]).forEach((k) => {
      const key = RISK_ATTR_KEYS[k];
      if (attrs[k]) setProfileSetting(profileId, key, "1");
      else deleteProfileSetting(profileId, key);
    });
  });
}

// Re-export so callers can reach the empty default alongside the getters.
export { EMPTY_RISK_ATTRIBUTES };

// ---- Training HR zones (issue #159) — profile scope, no migration ----
// A manual max-HR override for people who know theirs from a lab/field test (it
// beats the age formula), and the configurable weekly Zone 2 minutes target the
// endurance/longevity view tracks against. Both live in profile_settings.

// The manual max-HR override in bpm, or null when unset (the zone model then falls
// back to the Tanaka age estimate). Ignores an implausible stored value.
export function getMaxHrOverride(profileId: number): number | null {
  const raw = getProfileSetting(profileId, "max_hr_override");
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// Set (or clear, with null/0) the manual max-HR override.
export function setMaxHrOverride(profileId: number, bpm: number | null): void {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) {
    deleteProfileSetting(profileId, "max_hr_override");
    return;
  }
  setProfileSetting(profileId, "max_hr_override", String(Math.round(bpm)));
}

// The weekly Zone 2 minutes target. Defaults to 150 (the common aerobic-base
// recommendation) when unset. A stored 0 means "no target".
export const DEFAULT_ZONE2_WEEKLY_TARGET_MIN = 150;

export function getZone2WeeklyTargetMin(profileId: number): number {
  const raw = getProfileSetting(profileId, "zone2_weekly_target_min");
  if (raw == null || raw === "") return DEFAULT_ZONE2_WEEKLY_TARGET_MIN;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0
    ? Math.round(n)
    : DEFAULT_ZONE2_WEEKLY_TARGET_MIN;
}

export function setZone2WeeklyTargetMin(profileId: number, min: number): void {
  if (!Number.isFinite(min) || min < 0) return;
  setProfileSetting(
    profileId,
    "zone2_weekly_target_min",
    String(Math.round(min))
  );
}

// ---- Fitness-check retest cadence (issue #834) — profile scope, no migration ----
// How many days between guided Fitness checks before the coaching-tier "check due" nudge
// surfaces (~quarterly default). A generic profile_settings KV — no schema change.
export function getFitnessRetestCadenceDays(profileId: number): number {
  const raw = getProfileSetting(profileId, "fitness_retest_cadence_days");
  if (raw == null || raw === "") return DEFAULT_FITNESS_RETEST_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.round(n)
    : DEFAULT_FITNESS_RETEST_DAYS;
}

export function setFitnessRetestCadenceDays(
  profileId: number,
  days: number
): void {
  if (!Number.isFinite(days) || days <= 0) return;
  setProfileSetting(
    profileId,
    "fitness_retest_cadence_days",
    String(Math.round(days))
  );
}

// ---- Per-metric source priority (issue #14) — profile scope, no migration ----
// Which source is authoritative ("primary") for a metric when several report it
// (Health Connect vs Oura vs Strava vs manual). Stored as ONE JSON object in
// profile_settings; the (de)serialization + preference math is the pure
// lib/metric-source-priority. Unset metrics fall back to the default provider
// preference (single-source passthrough) — see the query layer.

export function getMetricSourcePriority(
  profileId: number
): MetricSourcePriority {
  return parseMetricSourcePriority(
    getProfileSetting(profileId, METRIC_SOURCE_PRIORITY_KEY)
  );
}

// Set (or clear, with null/"") the primary source for one metric. The metric key
// is validated by the CALLER (the server action allowlists COMPARABLE_METRICS);
// the source id is shape-checked here so a forged post can't store a blob.
export function setMetricSourcePriorityEntry(
  profileId: number,
  metric: string,
  source: string | null
): void {
  if (source != null && source !== "" && !isValidSourceId(source)) {
    throw new Error(`Invalid source id: ${source}`);
  }
  const next = withMetricSource(
    getMetricSourcePriority(profileId),
    metric,
    source
  );
  if (Object.keys(next).length === 0) {
    deleteProfileSetting(profileId, METRIC_SOURCE_PRIORITY_KEY);
    return;
  }
  setProfileSetting(
    profileId,
    METRIC_SOURCE_PRIORITY_KEY,
    serializeMetricSourcePriority(next)
  );
}

export interface ProfileAdoption {
  sexAdopted: boolean; // sex-specific bands may now apply to ALL existing records
  birthdate: string | null; // a birthdate that was adopted (for caller logging)
  age: number | null; // an age fallback that was adopted (for caller logging)
  fullName: string | null; // a full name that was adopted (for caller logging)
  homeAdopted: boolean; // a coarse home location was adopted from the patient ZIP
  bloodType: string | null; // a blood type that was adopted (for caller logging)
  changed: boolean; // any profile field was written
}

// Backfill the profile's blood type from a document's READINGS, never overwriting
// one the user set. The metadata-driven adoption below can't do this: a blood type
// isn't document metadata like sex or birthdate — it arrives as a lab row.
//
// Without this a blood type only reaches the emergency card / passport / FHIR export
// if the user types it in by hand: the derived path (profile-summary-load) looks up
// two records canonically named "ABO Blood Group" and "Rh Type", which nothing maps
// a LOINC onto, so a real imported row (Epic's combined "ABORh Interpretation")
// resolves to nothing and the card reads "Unknown" with the record sitting in the DB.
// Adopting at import time settles it once instead of re-deriving per read.
//
// Adopt-if-unset, like every other field here: the manual value already takes
// precedence when the summary is built, so this can only ever fill a blank.
// Idempotent — a reprocess re-adopts the same halves or no-ops.
//
// Each HALF is adopted on its own, which is the whole point of storing them apart:
// a document carrying only the ABO group fills the group and leaves the Rh blank
// for a later one to complete, instead of an incomplete result being dropped. The
// Rh is adopted even with no group yet on file — it is meaningless to DISPLAY
// alone (getBloodType stays null), but keeping it means the group's arrival
// completes the type rather than starting over.
//
// Returns the resulting printable type when anything was adopted, else null.
export function adoptBloodTypeFromRecords(
  profileId: number,
  readings: readonly BloodGroupReading[] | null | undefined
): string | null {
  if (!readings?.length) return null;
  const found = bloodGroupPartsFromReadings(readings);
  if (!found.abo && !found.rh) return null;
  const current = getBloodTypeParts(profileId);
  let adopted = false;
  // Never overwrite a half already on file — the user's or an earlier import's.
  if (found.abo && !current.abo) {
    setProfileSetting(profileId, BLOOD_ABO_KEY, found.abo);
    adopted = true;
  }
  if (found.rh && !current.rh) {
    setProfileSetting(profileId, BLOOD_RH_KEY, found.rh);
    adopted = true;
  }
  return adopted ? getBloodType(profileId) : null;
}

// Backfill the user's profile (sex, birthdate/age, full name) from an extracted
// document's metadata, without ever overwriting a value the user already set —
// prefer a birthdate over a bare age. Shared by every document-import path so
// adoption is consistent regardless of which one the user takes. Returns what
// changed so the caller can re-derive flags (on a new sex) and revalidate.
export function adoptProfileFromExtraction(
  profileId: number,
  meta: {
    patient_sex: Sex | null;
    patient_birthdate: string | null;
    patient_age: number | null;
    patient_name?: string | null;
    patient_postal_code?: string | null;
  } | null
): ProfileAdoption {
  const out: ProfileAdoption = {
    sexAdopted: false,
    birthdate: null,
    age: null,
    fullName: null,
    homeAdopted: false,
    bloodType: null,
    changed: false,
  };
  if (!meta) return out;

  if (meta.patient_sex !== null && getUserSex(profileId) === null) {
    setUserSex(profileId, meta.patient_sex);
    out.sexAdopted = true;
    out.changed = true;
  }
  if (meta.patient_name && getUserFullName(profileId) === null) {
    setUserFullName(profileId, meta.patient_name);
    out.fullName = meta.patient_name.trim() || null;
    out.changed = true;
  }
  if (getUserBirthdate(profileId) === null) {
    if (meta.patient_birthdate) {
      setUserBirthdate(profileId, meta.patient_birthdate);
      out.birthdate = meta.patient_birthdate;
      out.changed = true;
    } else if (meta.patient_age !== null && getStoredAge(profileId) === null) {
      setStoredAge(profileId, meta.patient_age);
      out.age = meta.patient_age;
      out.changed = true;
    }
  }
  // Home location (issue #570): suggest a COARSE ZIP-centroid home location from the
  // patient's own postal code, ONLY when none is set (never overwrite a user value) —
  // the same only-when-unset backfill the demographics above use. The centroid is
  // already ~11 km coarse (no street address), US-only; a non-US/unknown ZIP resolves
  // to null and is skipped. Editable/removable in Settings → Profile.
  if (meta.patient_postal_code && getHomeLocation(profileId) === null) {
    const home = zipToHome(meta.patient_postal_code);
    if (home) {
      setHomeLocation(profileId, home);
      out.homeAdopted = true;
      out.changed = true;
    }
  }
  return out;
}

// ---- Emergency card (issue #42) ----
// Whether the offline emergency card is cached for this profile. Default OFF: the
// card holds the profile's allergies/meds/conditions, and caching it offline means
// a stolen UNLOCKED phone (or shared device) can read it without a login — which is
// simultaneously the point (a first responder needs it) and the trade-off, so it's
// strictly opt-in per profile.
export function getEmergencyCardEnabled(profileId: number): boolean {
  return getProfileSetting(profileId, "emergency_card_offline") === "1";
}

export function setEmergencyCardEnabled(
  profileId: number,
  enabled: boolean
): void {
  setProfileSetting(profileId, "emergency_card_offline", enabled ? "1" : "0");
}

// ---- Blood group ----
// The profile's blood type, stored as its two INDEPENDENT halves: the ABO group
// ("A"/"B"/"AB"/"O") and the Rh factor ("+"/"-"). Migration 035 split the single
// legacy `blood_type` key into these.
//
// It is two keys because the halves genuinely arrive apart. A document may report
// only the ABO group (Rh not drawn, or not reported) and a later one completes it —
// and a lab reports "Rh Type" as its own row. Held as one composed string, a partial
// result had nowhere to live: "O" isn't a member of BLOOD_TYPES, so normalizeBloodType
// rejected it and an ABO-only import silently stored NOTHING. Split, each half is
// kept the moment it's known and the next import fills the other.
const BLOOD_ABO_KEY = "blood_type_abo";
const BLOOD_RH_KEY = "blood_type_rh";

// The stored halves, each null when unknown.
export function getBloodTypeParts(profileId: number): BloodGroupParts {
  const abo = normalizeAbo(getProfileSetting(profileId, BLOOD_ABO_KEY));
  const rh = normalizeRh(getProfileSetting(profileId, BLOOD_RH_KEY));
  return { abo, rh };
}

// The printable blood type ("O+", or "O" while the Rh is still unknown), or null
// when no ABO group is on file. Unchanged contract for every reader (emergency
// card, passport, export): an Rh factor alone stays meaningless, exactly as
// resolveBloodType has always treated it.
export function getBloodType(profileId: number): string | null {
  const { abo, rh } = getBloodTypeParts(profileId);
  return abo ? resolveBloodType(abo, rh) : null;
}

// Set the blood type from a printable value ("O+", "O Positive", or a bare "O").
// Splits it into the two stored halves; a value with no recognizable ABO group
// clears BOTH (the Settings → Profile "Unknown" option sends an empty string).
// Parsed with the same normalizers the readings path uses, so a hand-entered value
// and an imported one canonicalize identically.
export function setBloodType(profileId: number, value: string | null): void {
  const abo = normalizeAbo(value);
  if (!abo) {
    deleteProfileSetting(profileId, BLOOD_ABO_KEY);
    deleteProfileSetting(profileId, BLOOD_RH_KEY);
    return;
  }
  setProfileSetting(profileId, BLOOD_ABO_KEY, abo);
  const rh = normalizeRh(value);
  if (rh) setProfileSetting(profileId, BLOOD_RH_KEY, rh);
  else deleteProfileSetting(profileId, BLOOD_RH_KEY);
}

// The profile's emergency contact — the person a first responder should call.
// Three discrete keys in profile_settings (name / phone / relation), all optional;
// the card shows the contact only when at least a name or phone is set.
export interface EmergencyContactSetting {
  name: string;
  phone: string;
  relation: string;
}

export function getEmergencyContact(
  profileId: number
): EmergencyContactSetting {
  return {
    name: getProfileSetting(profileId, "emergency_contact_name") ?? "",
    phone: getProfileSetting(profileId, "emergency_contact_phone") ?? "",
    relation: getProfileSetting(profileId, "emergency_contact_relation") ?? "",
  };
}

export function setEmergencyContact(
  profileId: number,
  contact: EmergencyContactSetting
): void {
  writeTx(() => {
    const set = (key: string, value: string) => {
      const v = value.trim().slice(0, 200);
      if (v) setProfileSetting(profileId, key, v);
      else deleteProfileSetting(profileId, key);
    };
    set("emergency_contact_name", contact.name);
    set("emergency_contact_phone", contact.phone);
    set("emergency_contact_relation", contact.relation);
  });
}

// One situation in the profile's vocabulary (issue #560): an id-keyed row, not a
// free-text string. `active` is the current toggle state a situational supplement
// keys on.
export interface Situation {
  id: number;
  name: string;
  active: number;
  // #799: an illness-type situation is a symptom-log container — the symptom card and
  // the derived episode association key ONLY on flagged situations. 0/1.
  illness_type: number;
}

// The profile's whole situation vocabulary (active + inactive), for the toggle bar.
export function getSituations(profileId: number): Situation[] {
  return db
    .prepare(
      `SELECT id, name, active, illness_type FROM situations
        WHERE profile_id = ? ORDER BY name COLLATE NOCASE`
    )
    .all(profileId) as Situation[];
}

// The illness-type situations (#799), each with its current active state — the input
// the derived episode association (lib/symptom-episode.ts) keys on. Only flagged rows,
// so Travel/High-stress can never form a symptom episode.
export function getIllnessSituations(
  profileId: number
): { name: string; active: boolean }[] {
  return (
    db
      .prepare(
        `SELECT name, active FROM situations
          WHERE profile_id = ? AND illness_type = 1 ORDER BY name COLLATE NOCASE`
      )
      .all(profileId) as { name: string; active: number }[]
  ).map((r) => ({ name: r.name, active: !!r.active }));
}

// Whether an illness-type situation is CURRENTLY active — the dashboard symptom-card
// gate (#799). Cheap boolean over the same flagged set.
export function hasActiveIllnessSituation(profileId: number): boolean {
  return (
    (db
      .prepare(
        `SELECT 1 FROM situations
            WHERE profile_id = ? AND active = 1 AND illness_type = 1 LIMIT 1`
      )
      .get(profileId) as unknown) != null
  );
}

// Toggle a situation's illness_type flag (#799) — the situations-bar opt-in for a
// user-created situation. Resolves (get-or-create) the id-keyed row first so a not-yet-
// persisted suggested chip can be flagged; the built-in "Illness" is created flagged by
// resolveSituationId regardless.
export function setSituationIllnessType(
  profileId: number,
  name: string,
  illnessType: boolean
): void {
  writeTx(() => {
    const id = resolveSituationId(profileId, name);
    if (id == null) return;
    db.prepare(
      `UPDATE situations SET illness_type = ? WHERE id = ? AND profile_id = ?`
    ).run(illnessType ? 1 : 0, id, profileId);
    // Keep the open-episode row coherent (#856): a situation is an episode container
    // only while it is illness-type AND active. Flagging an active situation opens an
    // episode; un-flagging one closes its open episode.
    const active =
      (
        db
          .prepare(
            `SELECT active FROM situations WHERE id = ? AND profile_id = ?`
          )
          .get(id, profileId) as { active: number } | undefined
      )?.active === 1;
    syncOpenIllnessEpisode(
      profileId,
      normalizeSituationName(name),
      illnessType && active,
      today(profileId)
    );
  });
}

// Get-or-create the situation ROW for a name, returning its id (or null for an
// empty name). NOCASE-matched against the one vocabulary, so casing/whitespace
// variants ("illness" / " Illness ") resolve to the SAME row (#560 removes the
// #203 exact-string fragility). Kept a plain read/write so it composes inside a
// caller's writeTx (supplement create/edit).
export function resolveSituationId(
  profileId: number,
  name: string
): number | null {
  const norm = normalizeSituationName(name);
  if (!norm) return null;
  const existing = db
    .prepare(
      `SELECT id FROM situations WHERE profile_id = ? AND name = ? COLLATE NOCASE`
    )
    .get(profileId, norm) as { id: number } | undefined;
  if (existing) return existing.id;
  // The built-in "Illness" is born illness-type-flagged (#799) — the canonical symptom
  // container. Every other situation starts unflagged and opts in via the bar.
  const illnessType = isBuiltInIllnessSituation(norm) ? 1 : 0;
  return Number(
    db
      .prepare(
        `INSERT INTO situations (profile_id, name, active, illness_type) VALUES (?, ?, 0, ?)`
      )
      .run(profileId, norm, illnessType).lastInsertRowid
  );
}

// Currently-active situation NAMES for a profile (e.g. "Illness", "Travel"), read
// from the id-keyed situations table. Returned as names because that stays the
// shared currency across the notifier / adherence / digest layers — and, since
// getSupplements coalesces the same situations.name onto each item, a rename
// re-keys both sides together (no detachment).
export function getActiveSituations(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM situations
          WHERE profile_id = ? AND active = 1 ORDER BY name COLLATE NOCASE`
      )
      .all(profileId) as { name: string }[]
  ).map((r) => r.name);
}

// Set the profile's active situations to exactly `situations` (by name). Rows are
// upserted into the one NOCASE vocabulary and their `active` flag toggled; a name
// not previously seen becomes a new row. The dated start/stop transitions are still
// logged (Trends annotations) for chartability.
export function setActiveSituations(profileId: number, situations: string[]) {
  const before = getActiveSituations(profileId);
  const distinct = [
    ...new Map(
      situations
        .map((s) => normalizeSituationName(s))
        .filter(Boolean)
        .map((s) => [s.toLowerCase(), s])
    ).values(),
  ];
  const events = diffSituations(before, distinct, today(profileId));
  writeTx(() => {
    const wanted = new Set<number>();
    for (const name of distinct) {
      const id = resolveSituationId(profileId, name);
      if (id != null) wanted.add(id);
    }
    // Deactivate everything, then activate the wanted set — one vocabulary, so a
    // toggled-off situation's ROW survives (its situational supplements keep their
    // link) but reads as inactive.
    db.prepare(`UPDATE situations SET active = 0 WHERE profile_id = ?`).run(
      profileId
    );
    for (const id of wanted) {
      db.prepare(
        `UPDATE situations SET active = 1 WHERE id = ? AND profile_id = ?`
      ).run(id, profileId);
    }
    // Keep the open illness-episode rows coherent with the active set (#856), in the
    // SAME writeTx — every illness-type situation opens a row while active, closes it
    // when deactivated. Single write path; the row and the active flag never disagree.
    const onDate = today(profileId);
    const illness = db
      .prepare(
        `SELECT name, active FROM situations
          WHERE profile_id = ? AND illness_type = 1`
      )
      .all(profileId) as { name: string; active: number }[];
    for (const s of illness) {
      syncOpenIllnessEpisode(profileId, s.name, !!s.active, onDate);
    }
    if (events.length > 0) {
      setProfileSetting(
        profileId,
        "situation_events",
        serializeSituationEvents(
          parseSituationEvents(
            getProfileSetting(profileId, "situation_events")
          ),
          events
        )
      );
    }
  });
}

// The profile's active-situation change log (Trends event annotations):
// the dated start/stop transitions appended by setActiveSituations.
// Read defensively — a malformed blob yields an empty list.
export function getSituationEvents(profileId: number): SituationEvent[] {
  return parseSituationEvents(getProfileSetting(profileId, "situation_events"));
}

// ---- AI recommendation runs (issue #424) — profile scope, no migration ----
// The per-profile cadence for proactive AI recommendation runs (supplement
// suggestions + daily insight), plus the run markers that mirror notify_last_*
// discipline: the last run timestamp (cadence pacing) and the last input
// signature (skip a run when nothing changed). Cadence is admin-editable only —
// the admin pays for the API key — but the VALUE is per-profile, so it lives here.
import {
  parseCadence,
  type RecommendationCadence,
} from "../recommendation-run";

export function getRecommendationCadence(
  profileId: number
): RecommendationCadence {
  return parseCadence(getProfileSetting(profileId, "recommendation_cadence"));
}

export function setRecommendationCadence(
  profileId: number,
  cadence: RecommendationCadence
): void {
  setProfileSetting(profileId, "recommendation_cadence", cadence);
}

export function getRecommendationLastRunAt(profileId: number): string | null {
  return getProfileSetting(profileId, "recommendation_last_run_at") ?? null;
}

export function setRecommendationLastRunAt(
  profileId: number,
  iso: string
): void {
  setProfileSetting(profileId, "recommendation_last_run_at", iso);
}

export function getRecommendationLastSignature(
  profileId: number
): string | null {
  return getProfileSetting(profileId, "recommendation_last_signature") ?? null;
}

export function setRecommendationLastSignature(
  profileId: number,
  signature: string
): void {
  setProfileSetting(profileId, "recommendation_last_signature", signature);
}
