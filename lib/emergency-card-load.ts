import { getProfileSummary } from "./profile-summary-load";
import { getBloodType, getEmergencyContact } from "./settings";
import { buildEmergencyCard, type EmergencyCard } from "./emergency-card";
import { openEpisodeForProfile } from "./illness-episode";
import { emergencyEpisodeSection } from "./illness-episode-format";
import type { TemperatureUnit } from "./settings";
import type { TimeFormat } from "./format-date";

// Server-side gathering for the offline Emergency Card (issue #42). It reuses the
// passport's getProfileSummary() — the same profile-scoped queries that back the
// Health Passport — so the emergency card can NEVER disagree with the passport on
// allergies / active meds / conditions / blood type. Blood type included: the
// passport now folds the manually-entered value into getProfileSummary() with the
// SAME manual-wins precedence this card uses (#385), so both surfaces resolve the
// identical blood type (a manual "O+" no longer shows on the card while the
// passport reads "Unknown"). We still pass manualBloodType explicitly below so the
// card's own resolution is self-contained (and identical). Only the emergency
// contact is a card-only extra fact. The card model itself is assembled by the
// pure buildEmergencyCard(); this module just does the DB reads.

export function getEmergencyCard(
  profileId: number,
  fallbackName: string,
  generatedAt: string = new Date().toISOString(),
  // The viewer's temperature-unit preference for the active-episode section's latest
  // temp (issue #859 item 6). Defaults to °F (the storage-canonical unit) for callers
  // without a login context (the offline copy is preformatted at load time).
  temperatureUnit: TemperatureUnit = "F",
  timeFormat?: TimeFormat
): EmergencyCard {
  const summary = getProfileSummary(profileId, fallbackName);
  const contact = getEmergencyContact(profileId);

  // The active-illness-episode section — present only while an episode is open
  // (issue #859 item 6). Formatter over the ONE assembly, so it can't disagree with
  // the episode page.
  const openEp = openEpisodeForProfile(profileId);
  const activeEpisode = openEp
    ? emergencyEpisodeSection(openEp, temperatureUnit, timeFormat)
    : null;

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
    activeEpisode,
    generatedAt,
  });
}
