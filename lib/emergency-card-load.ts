import { getProfileSummary } from "./profile-summary-load";
import { getBloodType, getEmergencyContact } from "./settings";
import { buildEmergencyCard, type EmergencyCard } from "./emergency-card";

// Server-side gathering for the offline Emergency Card (issue #42). It reuses the
// passport's getProfileSummary() — the same profile-scoped queries that back the
// Health Passport — so the emergency card can NEVER disagree with the passport on
// allergies / active meds / conditions / blood type. Only two extra facts are
// pulled: the manually-entered blood type and the emergency contact, both per-
// profile settings. The card model itself is assembled by the pure
// buildEmergencyCard(); this module just does the DB reads.

export function getEmergencyCard(
  profileId: number,
  fallbackName: string,
  generatedAt: string = new Date().toISOString()
): EmergencyCard {
  const summary = getProfileSummary(profileId, fallbackName);
  const contact = getEmergencyContact(profileId);

  return buildEmergencyCard({
    name: summary.identity.name,
    age: summary.identity.age,
    sex: summary.identity.sex,
    birthdate: summary.identity.birthdate,
    // Manual blood type wins over the lab-derived one resolved by the passport.
    manualBloodType: getBloodType(profileId),
    derivedBloodType: summary.identity.bloodType,
    allergies: summary.allergies.map((a) => ({
      substance: a.substance,
      reaction: a.reaction,
      severity: a.severity,
    })),
    medications: summary.medications.map((m) => ({
      name: m.name,
      detail: m.detail,
    })),
    conditions: summary.conditions.map((c) => ({
      name: c.name,
      onsetDate: c.onsetDate,
    })),
    contact: {
      name: contact.name || null,
      phone: contact.phone || null,
      relation: contact.relation || null,
    },
    generatedAt,
  });
}
