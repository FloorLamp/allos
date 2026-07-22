import { getSmokingHistory, getRiskAttributes } from "@/lib/settings";
import SmokingHistoryForm from "@/app/(app)/medical/background/SmokingHistoryForm";
import RiskFactorsForm from "@/app/(app)/medical/background/RiskFactorsForm";

// "Background" (former /medical/background index, #1042 phase 6) — the
// person-level medical context that isn't a discrete record: smoking history
// (#83) and health risk factors (#517), now a section of Records › Care ›
// Overview. These moved off Settings → Profile (#928) because they're data ABOUT
// the tracked person, not app configuration (the #343 equipment precedent).
// Storage stays in profile_settings; the forms and their actions are
// profile-scoped + requireWriteAccess. The Emergency Card (#42) settings left this
// section for the Passport (#1087), co-located with the card they configure — so
// Background no longer owns the #emergency-card anchor.
export default function BackgroundSection({
  profileId,
}: {
  profileId: number;
}) {
  return (
    <div className="space-y-6">
      <SmokingHistoryForm history={getSmokingHistory(profileId)} />
      <RiskFactorsForm attributes={getRiskAttributes(profileId)} />
    </div>
  );
}
