import {
  getSmokingHistory,
  getRiskAttributes,
  getEmergencyCardEnabled,
  getBloodType,
  getEmergencyContact,
} from "@/lib/settings";
import SmokingHistoryForm from "@/app/(app)/medical/background/SmokingHistoryForm";
import RiskFactorsForm from "@/app/(app)/medical/background/RiskFactorsForm";
import EmergencyCardSettings from "@/app/(app)/medical/background/EmergencyCardSettings";

// "Background" (former /medical/background index, #1042 phase 6) — the
// person-level medical context that isn't a discrete record: smoking history
// (#83), health risk factors (#517), and the emergency card (#42), now the
// #background section of /records. These moved off Settings → Profile (#928)
// because they're data ABOUT the tracked person, not app configuration (the #343
// equipment precedent). Storage stays in profile_settings; the forms and their
// actions are profile-scoped + requireWriteAccess. The emergency card keeps its
// own #emergency-card anchor (deep-linked from the Passport / onboarding).
export default function BackgroundSection({
  profileId,
}: {
  profileId: number;
}) {
  return (
    <div className="space-y-6">
      <SmokingHistoryForm history={getSmokingHistory(profileId)} />
      <RiskFactorsForm attributes={getRiskAttributes(profileId)} />
      <EmergencyCardSettings
        enabled={getEmergencyCardEnabled(profileId)}
        bloodType={getBloodType(profileId)}
        contact={getEmergencyContact(profileId)}
      />
    </div>
  );
}
