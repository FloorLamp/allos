import { db, today, writeTx } from "../db";
import { ageFromBirthdate, ageMonthsFrom } from "../date";
import type { Sex, ReproductiveStatus } from "../types";
import { normalizeBloodType } from "../emergency-card";
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
  changed: boolean; // any profile field was written
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
  } | null
): ProfileAdoption {
  const out: ProfileAdoption = {
    sexAdopted: false,
    birthdate: null,
    age: null,
    fullName: null,
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

// A manually-entered blood type for the profile (e.g. "O+"). The emergency card
// prefers this over one derived from lab records (ABO/Rh), since most people know
// their type without a lab on file. Stored canonicalized (see normalizeBloodType);
// null clears it. Kept in profile_settings like the other per-person facts.
export function getBloodType(profileId: number): string | null {
  return getProfileSetting(profileId, "blood_type") ?? null;
}

export function setBloodType(profileId: number, value: string | null): void {
  const v = normalizeBloodType(value);
  if (!v) {
    deleteProfileSetting(profileId, "blood_type");
    return;
  }
  setProfileSetting(profileId, "blood_type", v);
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

// Currently-active situations (e.g. "Illness", "Travel") for a profile, persisted
// as a JSON array so situational supplements surface only while the situation
// applies and the state is shared with the notifier.
export function getActiveSituations(profileId: number): string[] {
  const v = getProfileSetting(profileId, "active_situations");
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function setActiveSituations(profileId: number, situations: string[]) {
  const before = getActiveSituations(profileId);
  const distinct = [
    ...new Set(situations.map((s) => s.trim()).filter(Boolean)),
  ];
  // Log the start/stop transitions (Trends event annotations) before
  // overwriting the current set — profile_settings keeps only the CURRENT set, so
  // the dated change log is what makes situations chartable. Same JSON-in-settings
  // precedent as active_situations itself; no owned table.
  const events = diffSituations(before, distinct, today(profileId));
  writeTx(() => {
    setProfileSetting(profileId, "active_situations", JSON.stringify(distinct));
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
