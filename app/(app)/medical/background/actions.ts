"use server";
// Medical "Background" actions — smoking history (#83), health risk factors (#517),
// and the emergency card (#42). These moved here from Settings → Profile (#928): they
// are data ABOUT the tracked person, not configuration — the same data-vs-configuration
// distinction that moved Equipment out of Settings (#343). The move is surface-only:
// every field still lives in profile_settings and each action still gates on
// requireWriteAccess() (any login with write access to the active profile may edit),
// so the auth tier is unchanged (#319).
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  setSmokingHistory,
  setRiskAttributes,
  setRiskAttributesReviewed,
  setEmergencyCardEnabled,
  setBloodType,
  setEmergencyContact,
  setAdvanceDirectives,
} from "@/lib/settings";
import {
  parsePackYears,
  parseQuitYear,
  parseSmokingStatus,
} from "@/lib/smoking";

// ---- Smoking history (profile scope, issue #83) ----
// The structured smoking record (status / pack-years / quit year) — a property of
// the tracked person. Marks the entry 'manual' so a later CCD re-import never
// clobbers it. pack-years apply only to an ever-smoker and the quit year only to a
// former smoker (the setter drops the rest); the assessor uses this to activate the
// risk-gated lung LDCT / AAA screening reminders.
export async function saveSmokingHistory(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const status = parseSmokingStatus(
    String(formData.get("smoking_status") ?? "")
  );
  const packYears = parsePackYears(String(formData.get("pack_years") ?? ""));
  // Bound the quit year to a real, non-future year; parseQuitYear already rejects
  // an out-of-range value, and a future year is meaningless for "quit N years ago".
  const thisYear = new Date().getFullYear();
  const quitYearRaw = parseQuitYear(String(formData.get("quit_year") ?? ""));
  const quitYear =
    quitYearRaw != null && quitYearRaw <= thisYear ? quitYearRaw : null;

  setSmokingHistory(profile.id, { status, packYears, quitYear });
  // The record drives the preventive reminders (Upcoming) and the medical surface.
  revalidatePath("/upcoming");
  revalidatePath("/records");
}

// ---- Health risk factors (profile scope, issue #517) ----
// The self-declared occupational/immune context (healthcare worker,
// immunocompromised, on dialysis, pregnant) that the risk-stratification layer
// reads to modulate retest cadence + ranking. Boolean flags in profile_settings.
// Drives the Upcoming retest/screening ranking — informational only.
export async function saveRiskFactors(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const on = (key: string) => formData.get(key) === "1";
  setRiskAttributes(profile.id, {
    healthcareWorker: on("healthcare_worker"),
    immunocompromised: on("immunocompromised"),
    dialysis: on("dialysis"),
    pregnant: on("pregnant"),
    noiseExposure: on("noise_exposure"),
  });
  // Stamp the review marker (#1045): saving the form is the explicit review, so the
  // data-quality "review risk factors" gap clears even when the user leaves the list
  // empty (absence-of-flags can't tell an intentional empty review from a fresh one).
  setRiskAttributesReviewed(profile.id, true);
  revalidatePath("/upcoming");
  revalidatePath("/records");
  revalidatePath("/");
}

// ---- Emergency card (profile scope, issue #42) ----
// The offline emergency card opt-in, manual blood type, and emergency contact — all
// properties of the tracked person. setBloodType normalizes/validates the value; a
// blank or unrecognized blood type clears it.
export async function saveEmergencyCardSettings(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const enabledRaw = formData.get("emergency_enabled");
  setEmergencyCardEnabled(
    profile.id,
    enabledRaw === "1" || enabledRaw === "on"
  );
  setBloodType(profile.id, String(formData.get("blood_type") ?? ""));
  setEmergencyContact(profile.id, {
    name: String(formData.get("emergency_contact_name") ?? ""),
    phone: String(formData.get("emergency_contact_phone") ?? ""),
    relation: String(formData.get("emergency_contact_relation") ?? ""),
  });
  revalidatePath("/records");
  // The card renders as the Passport page's #emergency section (#1042 phase 3).
  revalidatePath("/profile");
}

// ---- Advance directives (profile scope, issue #1848) ----
// Code status (+ its effective date and free-text qualifier), the healthcare proxy,
// organ-donor status, and where the signed paperwork lives. The write core
// (setAdvanceDirectives) normalizes the two enums and clears any blank, so an
// unrecognized submitted value can never persist as a code status; this boundary
// only carries the form fields across. Same requireWriteAccess tier as the rest of
// the emergency-card settings, and the same revalidation targets — the passport
// page renders BOTH the card and the passport summary these facts appear on.
export async function saveAdvanceDirectives(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const field = (name: string) => String(formData.get(name) ?? "");
  setAdvanceDirectives(profile.id, {
    codeStatus: field("code_status"),
    codeStatusEffective: field("code_status_effective"),
    codeStatusNote: field("code_status_note"),
    proxyName: field("healthcare_proxy_name"),
    proxyRelation: field("healthcare_proxy_relation"),
    proxyPhone: field("healthcare_proxy_phone"),
    organDonor: field("organ_donor"),
    documentsAt: field("directive_documents_at"),
  });
  revalidatePath("/records");
  revalidatePath("/profile");
}
