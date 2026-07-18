import {
  getSmokingHistory,
  getRiskAttributes,
  getEmergencyCardEnabled,
  getBloodType,
  getEmergencyContact,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import SmokingHistoryForm from "./SmokingHistoryForm";
import RiskFactorsForm from "./RiskFactorsForm";
import EmergencyCardSettings from "./EmergencyCardSettings";

// "Background" — the person-level medical context that isn't a discrete record:
// smoking history (#83), health risk factors (#517), and the emergency card (#42).
// These moved off Settings → Profile (#928) because they're data ABOUT the tracked
// person, not app configuration (the #343 equipment precedent). Storage stays in
// profile_settings; the forms and their actions are profile-scoped + requireWriteAccess.
export const dynamic = "force-dynamic";

export default async function MedicalBackgroundPage() {
  const { profile } = await requireSession();

  return (
    <div>
      <PageHeader
        title="Background"
        subtitle={`${profile.name}’s smoking history, health risk factors, and emergency card — person-level context that tailors screening reminders and the offline emergency summary.`}
      />
      <div className="space-y-6">
        <SmokingHistoryForm history={getSmokingHistory(profile.id)} />
        <RiskFactorsForm attributes={getRiskAttributes(profile.id)} />
        <EmergencyCardSettings
          enabled={getEmergencyCardEnabled(profile.id)}
          bloodType={getBloodType(profile.id)}
          contact={getEmergencyContact(profile.id)}
        />
      </div>
    </div>
  );
}
